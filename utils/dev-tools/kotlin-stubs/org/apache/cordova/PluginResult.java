package org.apache.cordova;
public class PluginResult {
  public enum Status { NO_RESULT, OK, ERROR }
  public PluginResult(Status s) {} public PluginResult(Status s, String m) {} public PluginResult(Status s, byte[] data) {}
  public void setKeepCallback(boolean b) {} public boolean getKeepCallback() { return false; }
}