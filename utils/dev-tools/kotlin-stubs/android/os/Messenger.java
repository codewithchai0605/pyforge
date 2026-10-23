package android.os;
public class Messenger {
  public Messenger(Handler h) {} public Messenger(IBinder b) {}
  public IBinder getBinder() { return null; }
  public void send(Message m) throws RemoteException {}
}
