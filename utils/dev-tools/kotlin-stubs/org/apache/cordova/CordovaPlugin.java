package org.apache.cordova;
import org.json.*;
public class CordovaPlugin {
  public CordovaInterface cordova; public CordovaWebView webView;
  protected void pluginInitialize() {}
  public void onDestroy() {}
  public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException { return false; }
}
