package android.app;
import android.content.Context;
public abstract class Activity extends Context { public void runOnUiThread(Runnable r) { r.run(); } }
