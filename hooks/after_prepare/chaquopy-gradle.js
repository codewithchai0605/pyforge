"use strict";

/*
 * cordova-android writes the app buildscript before applying plugin Gradle
 * references. Chaquopy must be on that buildscript's classpath before the
 * pyruntime plugin applies it, so this deliberately small, idempotent hook
 * patches the generated file after every Cordova prepare.
 */
const fs = require("node:fs");
const path = require("node:path");

const CHAQUOPY = '        classpath "com.chaquo.python:gradle:17.1.0"';
const ANDROID_PLUGIN =
  '        classpath "com.android.tools.build:gradle:${cordovaConfig.AGP_VERSION}"';
const REPOSITORIES = "    repositories repos";
const CHAQUOPY_REPOSITORY =
  '    repositories { maven { url "https://chaquo.com/maven" } }';
const OLD_CHAQUOPY_REPOSITORY =
  '        maven { url "https://chaquo.com/maven" }';

module.exports = (context) => {
  if (!context.opts.platforms.includes("android")) return;

  const buildGradle = path.join(
    context.opts.projectRoot,
    "platforms",
    "android",
    "app",
    "build.gradle",
  );
  let text = fs.readFileSync(buildGradle, "utf8");
  if (!text.includes(ANDROID_PLUGIN) || !text.includes(REPOSITORIES)) {
    throw new Error("Cordova's Android buildscript layout changed; cannot add Chaquopy safely.");
  }

  // Repair the first version of this hook as well as adding the current form.
  text = text.replace(`${REPOSITORIES}\n${OLD_CHAQUOPY_REPOSITORY}`, REPOSITORIES);
  if (!text.includes(CHAQUOPY_REPOSITORY)) {
    text = text.replace(REPOSITORIES, `${REPOSITORIES}\n${CHAQUOPY_REPOSITORY}`);
  }
  if (!text.includes(CHAQUOPY)) {
    text = text.replace(ANDROID_PLUGIN, `${ANDROID_PLUGIN}\n${CHAQUOPY}`);
  }
  fs.writeFileSync(buildGradle, text);
};
