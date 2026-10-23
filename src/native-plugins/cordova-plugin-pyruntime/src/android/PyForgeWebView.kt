package com.pyforge.pyruntime

import android.content.Context
import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import org.apache.cordova.CordovaPreferences
import org.apache.cordova.engine.SystemWebView
import org.apache.cordova.engine.SystemWebViewEngine

/**
 * The app's WebView: Cordova's stock one, plus one ability, not showing the
 * floating Cut / Copy / Paste bar Android draws over selected text.
 *
 * Why this has to be native: that bar is an Android ActionMode the WebView
 * starts itself when text is selected. The page has no event for it and no
 * CSS for it (contenteditable text can't opt out of selection), so the page
 * can only draw its own bar (src/components/selectionMenu.tsx) and ask the
 * native side to stay quiet. The page does that through
 * PyRuntimePlugin's "selectionBar" action, only while the editor has focus:
 * ordinary text fields (a file name, the search box) keep the system bar so
 * they can still paste.
 *
 * What is NOT touched: the selection itself and its two drag handles. The
 * ActionMode is still created (if it were refused, the WebView would drop the
 * selection); it is just given nothing to show.
 *
 * Installed by the `webview` preference (plugin.xml / config.xml), which
 * makes Cordova create PyForgeWebViewEngine instead of its default engine.
 */
class PyForgeWebView(context: Context) : SystemWebView(context) {

    /** While true the system selection bar is not shown. Set from JavaScript. */
    @Volatile
    var hideSelectionBar: Boolean = false

    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? {
        if (!hideSelectionBar || callback == null) return super.startActionMode(callback, type)
        return super.startActionMode(EmptyBarCallback(callback), type)
    }
}

/**
 * Cordova's engine, building [PyForgeWebView] instead of a plain SystemWebView.
 * Cordova finds this class by name and requires exactly this constructor
 * (see CordovaWebViewImpl.createEngine), so keep it public and unchanged.
 */
class PyForgeWebViewEngine(context: Context, preferences: CordovaPreferences) :
    SystemWebViewEngine(PyForgeWebView(context), preferences)

/**
 * Passes everything through to the WebView's own callback, then makes the
 * result invisible: the menu is emptied (so there are no buttons) and the
 * bar's anchor rectangle is parked far off-screen (so the platform treats it
 * as scrolled out of view and hides it, instead of drawing an empty pill).
 */
private class EmptyBarCallback(private val inner: ActionMode.Callback) : ActionMode.Callback2() {

    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        val keep = inner.onCreateActionMode(mode, menu)
        menu.clear()
        return keep
    }

    // The WebView refills the menu on every selection change, so empty it every time.
    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        val keep = inner.onPrepareActionMode(mode, menu)
        menu.clear()
        return keep
    }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean =
        inner.onActionItemClicked(mode, item)

    override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
        if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect)
        else super.onGetContentRect(mode, view, outRect)
        outRect.set(OFF_SCREEN, OFF_SCREEN, OFF_SCREEN + 1, OFF_SCREEN + 1)
    }

    private companion object {
        const val OFF_SCREEN = -100_000
    }
}
