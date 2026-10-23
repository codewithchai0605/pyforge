package android.app;
import android.content.*; import android.os.IBinder;
public abstract class Service extends Context {
  public abstract IBinder onBind(Intent intent);
  public void onDestroy() {}
}
