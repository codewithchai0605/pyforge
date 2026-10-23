package com.chaquo.python;
public class Python {
  public interface Platform {}
  public static boolean isStarted() { return false; } public static void start(Platform p) {}
  public static Python getInstance() { return null; } public PyObject getModule(String n) { return null; }
}
