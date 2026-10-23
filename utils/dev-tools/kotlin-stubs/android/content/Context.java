package android.content;
import java.io.File;
public abstract class Context {
  public File getFilesDir() { return null; }
  public File getCacheDir() { return null; }
  public android.content.res.Resources getResources() { return null; }
  public Context getApplicationContext() { return this; }
  public boolean bindService(Intent i, ServiceConnection c, int flags) { return true; }
  public void unbindService(ServiceConnection c) {}
  public static final int BIND_AUTO_CREATE = 1;
}
