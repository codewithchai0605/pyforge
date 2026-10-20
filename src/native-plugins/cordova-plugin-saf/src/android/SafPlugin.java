package com.pyforge.saf;

import android.app.Activity;
import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.documentfile.provider.DocumentFile;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Storage Access Framework (scoped storage) access. Every document is
 * addressed by its raw `content://...` URI string — the same string
 * `DocumentFile.getUri().toString()` returns — rather than Acode's
 * sdcard plugin's custom `::`-separated composite IDs; a plain URI string
 * is simpler and already unique, so there's no real need for a second
 * encoding on top of it.
 *
 * Every action after pickFolder() takes a URI obtained from a previous
 * call (pickFolder's result, or one of listDir()'s child `url` fields) —
 * see resolveDocumentFile() for how both a fresh tree-picker URI and an
 * already-document-shaped URI get resolved correctly.
 */
public class SafPlugin extends CordovaPlugin {

    private static final int PICK_FOLDER_REQUEST_CODE = 9100;
    private static final int PERSISTABLE_FLAGS =
        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private CallbackContext pickFolderCallback;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        switch (action) {
            case "pickFolder":
                pickFolder(callbackContext);
                return true;
            case "listPersistedFolders":
                listPersistedFolders(callbackContext);
                return true;
            case "releaseFolder":
                releaseFolder(args.getString(0), callbackContext);
                return true;
            case "stat":
                cordova.getThreadPool().execute(() -> stat(args, callbackContext));
                return true;
            case "listDir":
                cordova.getThreadPool().execute(() -> listDir(args, callbackContext));
                return true;
            case "readFile":
                cordova.getThreadPool().execute(() -> readFile(args, callbackContext));
                return true;
            case "writeFile":
                cordova.getThreadPool().execute(() -> writeFile(args, callbackContext));
                return true;
            case "createFile":
                cordova.getThreadPool().execute(() -> createFile(args, callbackContext));
                return true;
            case "createDirectory":
                cordova.getThreadPool().execute(() -> createDirectory(args, callbackContext));
                return true;
            case "delete":
                cordova.getThreadPool().execute(() -> deleteDocument(args, callbackContext));
                return true;
            case "rename":
                cordova.getThreadPool().execute(() -> rename(args, callbackContext));
                return true;
            default:
                return false;
        }
    }

    // --- Folder picking ------------------------------------------------

    private void pickFolder(CallbackContext callbackContext) {
        pickFolderCallback = callbackContext;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(PERSISTABLE_FLAGS | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        cordova.startActivityForResult(this, intent, PICK_FOLDER_REQUEST_CODE);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FOLDER_REQUEST_CODE) return;
        if (pickFolderCallback == null) return;

        CallbackContext callback = pickFolderCallback;
        pickFolderCallback = null;

        if (resultCode != Activity.RESULT_OK || data == null) {
            callback.error("Folder selection cancelled");
            return;
        }

        Uri treeUri = data.getData();
        if (treeUri == null) {
            callback.error("No folder was returned by the picker");
            return;
        }

        try {
            cordova.getActivity().getContentResolver().takePersistableUriPermission(treeUri, PERSISTABLE_FLAGS);
            DocumentFile root = DocumentFile.fromTreeUri(cordova.getContext(), treeUri);
            if (root == null || !root.canWrite()) {
                callback.error("No write permission for the selected folder");
                return;
            }
            callback.success(root.getUri().toString());
        } catch (Exception e) {
            callback.error("Failed to take persistable permission: " + e.getMessage());
        }
    }

    private void listPersistedFolders(CallbackContext callbackContext) {
        try {
            List<UriPermission> permissions = cordova.getActivity().getContentResolver().getPersistedUriPermissions();
            JSONArray result = new JSONArray();
            for (UriPermission permission : permissions) {
                if (!permission.isReadPermission() || !permission.isWritePermission()) continue;
                DocumentFile root = DocumentFile.fromTreeUri(cordova.getContext(), permission.getUri());
                JSONObject entry = new JSONObject();
                entry.put("url", permission.getUri().toString());
                entry.put("name", root != null ? root.getName() : null);
                result.put(entry);
            }
            callbackContext.success(result);
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private void releaseFolder(String uriString, CallbackContext callbackContext) {
        try {
            cordova.getActivity().getContentResolver()
                .releasePersistableUriPermission(Uri.parse(uriString), PERSISTABLE_FLAGS);
            callbackContext.success();
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    // --- Document resolution --------------------------------------------

    /**
     * A URI fresh from pickFolder() is a *tree* URI only (no document id
     * attached yet) — DocumentFile.fromTreeUri() is what turns that into
     * the root document. Anything else passed into this plugin (the root's
     * own `.getUri()` after that conversion, or any child `url` from
     * listDir()) is already a proper *document* URI and resolves directly
     * via fromSingleUri(). Checking isDocumentUri() is what tells them apart.
     */
    private DocumentFile resolveDocumentFile(String uriString) {
        Uri uri = Uri.parse(uriString);
        // A tree URI may also satisfy isDocumentUri() on some Android
        // providers. Test the tree form first; resolving it as a single
        // document makes listFiles() fail (often with a null error message).
        if (DocumentsContract.isTreeUri(uri)) {
            return DocumentFile.fromTreeUri(cordova.getContext(), uri);
        }
        return DocumentFile.fromSingleUri(cordova.getContext(), uri);
    }

    private JSONObject statOf(DocumentFile file) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("name", file.getName());
        json.put("isDirectory", file.isDirectory());
        json.put("size", file.length());
        json.put("lastModified", file.lastModified());
        json.put("mimeType", file.getType());
        json.put("canWrite", file.canWrite());
        return json;
    }

    private JSONObject entryOf(DocumentFile file) throws JSONException {
        JSONObject json = statOf(file);
        json.put("url", file.getUri().toString());
        return json;
    }

    // --- Metadata / listing ----------------------------------------------

    private void stat(JSONArray args, CallbackContext callbackContext) {
        try {
            DocumentFile file = resolveDocumentFile(args.getString(0));
            if (file == null || !file.exists()) {
                callbackContext.error("Not found: " + args.getString(0));
                return;
            }
            callbackContext.success(statOf(file));
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private void listDir(JSONArray args, CallbackContext callbackContext) {
        try {
            DocumentFile dir = resolveDocumentFile(args.getString(0));
            if (dir == null || !dir.isDirectory()) {
                callbackContext.error("Not a directory: " + args.getString(0));
                return;
            }
            JSONArray result = new JSONArray();
            for (DocumentFile child : dir.listFiles()) {
                result.put(entryOf(child));
            }
            callbackContext.success(result);
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    // --- Content I/O -------------------------------------------------------

    private void readFile(JSONArray args, CallbackContext callbackContext) {
        try {
            String uriString = args.getString(0);
            String encoding = args.length() > 1 && !args.isNull(1) ? args.getString(1) : "utf8";

            DocumentFile file = resolveDocumentFile(uriString);
            if (file == null || !file.exists()) {
                callbackContext.error("Not found: " + uriString);
                return;
            }

            byte[] bytes = readAllBytes(file.getUri());
            if ("base64".equals(encoding)) {
                callbackContext.success(Base64.encodeToString(bytes, Base64.NO_WRAP));
            } else {
                callbackContext.success(new String(bytes, StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private void writeFile(JSONArray args, CallbackContext callbackContext) {
        try {
            String uriString = args.getString(0);
            String content = args.getString(1);
            String encoding = args.length() > 2 && !args.isNull(2) ? args.getString(2) : "utf8";

            DocumentFile file = resolveDocumentFile(uriString);
            if (file == null || !file.exists()) {
                callbackContext.error("Not found: " + uriString);
                return;
            }
            if (!file.canWrite()) {
                callbackContext.error("No write permission: " + uriString);
                return;
            }

            byte[] bytes = "base64".equals(encoding)
                ? Base64.decode(content, Base64.DEFAULT)
                : content.getBytes(StandardCharsets.UTF_8);

            // "wt" = write + truncate, so a shorter new value doesn't leave
            // trailing bytes from the previous, longer content behind.
            try (OutputStream out = cordova.getActivity().getContentResolver().openOutputStream(file.getUri(), "wt")) {
                if (out == null) throw new IOException("openOutputStream returned null");
                out.write(bytes);
            }
            callbackContext.success();
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private byte[] readAllBytes(Uri uri) throws IOException {
        try (InputStream in = cordova.getActivity().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("openInputStream returned null");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[1 << 16];
            int n;
            while ((n = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, n);
            }
            return buffer.toByteArray();
        }
    }

    // --- Create / delete / rename ------------------------------------------

    private void createFile(JSONArray args, CallbackContext callbackContext) {
        try {
            DocumentFile parent = resolveDocumentFile(args.getString(0));
            String name = args.getString(1);
            String mimeType = args.length() > 2 && !args.isNull(2) ? args.getString(2) : "text/plain";

            if (parent == null || !parent.isDirectory()) {
                callbackContext.error("Parent is not a directory: " + args.getString(0));
                return;
            }
            DocumentFile created = parent.createFile(mimeType, name);
            if (created == null) {
                callbackContext.error("Failed to create file: " + name);
                return;
            }
            callbackContext.success(entryOf(created));
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private void createDirectory(JSONArray args, CallbackContext callbackContext) {
        try {
            DocumentFile parent = resolveDocumentFile(args.getString(0));
            String name = args.getString(1);

            if (parent == null || !parent.isDirectory()) {
                callbackContext.error("Parent is not a directory: " + args.getString(0));
                return;
            }
            DocumentFile created = parent.createDirectory(name);
            if (created == null) {
                callbackContext.error("Failed to create directory: " + name);
                return;
            }
            callbackContext.success(entryOf(created));
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private void deleteDocument(JSONArray args, CallbackContext callbackContext) {
        try {
            DocumentFile file = resolveDocumentFile(args.getString(0));
            if (file == null || !file.exists()) {
                callbackContext.error("Not found: " + args.getString(0));
                return;
            }
            if (file.delete()) {
                callbackContext.success();
            } else {
                callbackContext.error("Delete failed: " + args.getString(0));
            }
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }

    private void rename(JSONArray args, CallbackContext callbackContext) {
        try {
            DocumentFile file = resolveDocumentFile(args.getString(0));
            String newName = args.getString(1);

            if (file == null || !file.exists()) {
                callbackContext.error("Not found: " + args.getString(0));
                return;
            }
            // DocumentFile.renameTo() updates this SAME instance's internal
            // URI to whatever DocumentsContract.renameDocument() returns —
            // which is not guaranteed to equal the original URI with just
            // the filename swapped (a real SAF quirk). Read file.getUri()
            // again afterward rather than assuming; never reconstruct it
            // from the old URI + new name yourself.
            if (file.renameTo(newName)) {
                callbackContext.success(entryOf(file));
            } else {
                callbackContext.error("Rename failed: " + args.getString(0));
            }
        } catch (Exception e) {
            callbackContext.error(String.valueOf(e.getMessage()));
        }
    }
}
