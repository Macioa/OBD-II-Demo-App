package com.obdiidemoapp

import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.io.File

/** Saves the connection debug log to Downloads and/or shares it (email, Drive, etc). */
class DebugLogModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "DebugLog"

  /** Writes the log to the public Downloads folder. Resolves with a human-readable location. */
  @ReactMethod
  fun saveToDownloads(fileName: String, content: String, promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, fileName)
          put(MediaStore.Downloads.MIME_TYPE, "text/plain")
          put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: throw IllegalStateException("Could not create file in Downloads")
        ctx.contentResolver.openOutputStream(uri)!!.use { it.write(content.toByteArray()) }
        promise.resolve("Downloads/$fileName")
      } else {
        // Pre-Android 10: app-specific external dir (no storage permission needed).
        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
        val f = File(dir, fileName)
        f.writeText(content)
        promise.resolve(f.absolutePath)
      }
    } catch (e: Exception) {
      promise.reject("SAVE_FAILED", e.message, e)
    }
  }

  /** Opens the Android share sheet with the log attached (pick Gmail/email to send it). */
  @ReactMethod
  fun share(fileName: String, content: String, subject: String, promise: Promise) {
    try {
      val dir = File(ctx.cacheDir, "debug").apply { mkdirs() }
      val f = File(dir, fileName)
      f.writeText(content)
      val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.debuglog", f)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, "OBD-II Demo App connection debug log attached.")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, "Send debug log").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      (ctx.currentActivity ?: ctx).startActivity(chooser)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SHARE_FAILED", e.message, e)
    }
  }
}

class DebugLogPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(DebugLogModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
