package com.obdiidemoapp

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.WindowManager
import androidx.core.content.FileProvider
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import org.json.JSONObject
import java.io.File

/**
 * Streams accelerometer, gyroscope, magnetometer, rotation vector and GPS to JS,
 * and optionally records all of it to disk via [SessionRecorder].
 *
 * Samples are collected on one background thread and flushed as an "imuBatch"
 * event every [BATCH_MS]. Each stream is a flat array to keep bridge cost low:
 *   acc/gyr/mag: [t, x, y, z, ...]
 *   rot:         [t, x, y, z, w, ...]   (unit quaternion, world frame ENU)
 *   gps:         [t, lat, lon, acc, sats, ...]
 * t is seconds since start(), from the monotonic elapsedRealtime clock.
 *
 * While recording, stop() is ignored so switching screens never cuts a session.
 */
class SensorModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx), SensorEventListener {

  override fun getName() = "ImuSensors"

  private val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
  private val thread = HandlerThread("ImuSensors").apply { start() }
  private val handler = Handler(thread.looper)
  private val rec = SessionRecorder(ctx)
  private var running = false
  private var t0Ns = 0L
  private val lock = Any()
  private var acc = ArrayList<Double>()
  private var gyr = ArrayList<Double>()
  private var mag = ArrayList<Double>()
  private var rot = ArrayList<Double>()
  private var gpsBuf = ArrayList<Double>()
  private var magAccuracy = -1
  private var sats = -1
  private val quat = FloatArray(4)

  // Health stats per 5 s window, for the events log (a, g, m, r).
  private val winCount = IntArray(4)
  private val winMaxGap = DoubleArray(4)
  private val lastT = DoubleArray(4) { -1.0 }
  private var lastGpsT = -1.0
  private var lastGpsAcc = -1f

  private val flush = object : Runnable {
    override fun run() {
      emitBatch()
      handler.postDelayed(this, BATCH_MS)
    }
  }

  private val health = object : Runnable {
    override fun run() {
      if (rec.active) {
        val nowSensorT = (SystemClock.elapsedRealtimeNanos() - t0Ns) / 1e9
        val gpsAge = if (lastGpsT < 0) "none" else "%.1fs".format(nowSensorT - lastGpsT)
        rec.event(
          "health 5s counts a/g/m/r=${winCount.joinToString("/")} " +
            "maxGap ms=${winMaxGap.joinToString("/") { "%.0f".format(it * 1000) }} " +
            "magAcc=$magAccuracy gpsAge=$gpsAge gpsAcc=${lastGpsAcc}m sats=$sats " +
            "bytes=${rec.bytes} wall=${System.currentTimeMillis()}",
        )
        if (winCount.take(3).any { it == 0 }) rec.event("WARN a sensor delivered no samples in 5 s")
        rec.flush()
      }
      winCount.fill(0)
      winMaxGap.fill(0.0)
      handler.postDelayed(this, HEALTH_MS)
    }
  }

  private val gpsListener = object : LocationListener {
    override fun onLocationChanged(l: Location) {
      val t = (l.elapsedRealtimeNanos - t0Ns) / 1e9
      lastGpsT = t
      lastGpsAcc = l.accuracy
      synchronized(lock) {
        gpsBuf.add(t); gpsBuf.add(l.latitude); gpsBuf.add(l.longitude)
        gpsBuf.add(l.accuracy.toDouble()); gpsBuf.add(sats.toDouble())
      }
      rec.gps(t, l.latitude, l.longitude, l.altitude, l.accuracy, l.speed, l.bearing, sats)
    }
    override fun onProviderEnabled(p: String) { rec.event("location provider enabled: $p") }
    override fun onProviderDisabled(p: String) { rec.event("location provider DISABLED: $p") }
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(p: String?, s: Int, b: Bundle?) {}
  }

  private val gnss = object : GnssStatus.Callback() {
    override fun onSatelliteStatusChanged(status: GnssStatus) {
      sats = (0 until status.satelliteCount).count { status.usedInFix(it) }
    }
    override fun onStarted() { rec.event("gnss started") }
    override fun onStopped() { rec.event("gnss stopped") }
  }

  /** Which sensors exist on this phone, with vendor/name and max rate. */
  @ReactMethod
  fun getAvailability(promise: Promise) {
    val out = Arguments.createMap()
    for ((key, type) in TYPES) {
      val s = sm.getDefaultSensor(type)
      out.putMap(key, s?.let {
        Arguments.createMap().apply {
          putString("name", it.name)
          putString("vendor", it.vendor)
          putDouble("maxHz", maxHz(it))
        }
      })
    }
    promise.resolve(out)
  }

  @ReactMethod
  fun start(rateHz: Double, promise: Promise) {
    handler.post {
      if (running) {
        promise.resolve(-1)
        return@post
      }
      val periodUs = (1e6 / rateHz.coerceIn(1.0, 200.0)).toInt()
      t0Ns = SystemClock.elapsedRealtimeNanos()
      lastT.fill(-1.0)
      var registered = 0
      for ((_, type) in TYPES) {
        sm.getDefaultSensor(type)?.let {
          if (sm.registerListener(this, it, periodUs, handler)) registered++
        }
      }
      startGps()
      running = true
      handler.postDelayed(flush, BATCH_MS)
      handler.postDelayed(health, HEALTH_MS)
      promise.resolve(registered)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    handler.post {
      if (rec.active) {
        rec.event("sensor stop requested while recording; kept running")
        promise.resolve(false)
      } else {
        stopInternal()
        promise.resolve(true)
      }
    }
  }

  /** Starts a session. Sensors must already be running (call start first). */
  @ReactMethod
  fun startRecording(meta: ReadableMap, promise: Promise) {
    handler.post {
      if (!running) {
        promise.reject("NOT_RUNNING", "Call start() before startRecording()")
        return@post
      }
      try {
        val id = rec.start(t0Ns, JSONObject(meta.toHashMap()), sensorInfoJson())
        // Restart the health window so the first line covers a full 5 s.
        winCount.fill(0)
        winMaxGap.fill(0.0)
        handler.removeCallbacks(health)
        handler.postDelayed(health, HEALTH_MS)
        if (!hasLocationPermission()) rec.event("WARN no location permission: gps.csv will be empty")
        setKeepScreenOn(true)
        promise.resolve(id)
      } catch (e: Exception) {
        promise.reject("REC_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun stopRecording(meta: ReadableMap, promise: Promise) {
    handler.post {
      val id = rec.id
      rec.stop(JSONObject(meta.toHashMap()))
      setKeepScreenOn(false)
      promise.resolve(id)
    }
  }

  /** Appends a line to the current session's events.log (no-op when idle). */
  @ReactMethod
  fun logEvent(msg: String) {
    handler.post { rec.event(msg) }
  }

  @ReactMethod
  fun listRecordings(promise: Promise) {
    handler.post {
      val arr = Arguments.createArray()
      for ((d, m) in SessionRecorder.list(ctx)) {
        arr.pushMap(Arguments.createMap().apply {
          putString("id", d.name)
          putBoolean("active", d.name == rec.id)
          putDouble("bytes", m.optLong("bytes").toDouble())
          putDouble("durationS", m.optDouble("durationS", -1.0))
          putString("startedAt", m.optString("startedAt"))
          val rows = m.optJSONObject("rows")
          putDouble("gpsFixes", rows?.optDouble("gps", 0.0) ?: 0.0)
          putDouble("accRows", rows?.optDouble("acc", 0.0) ?: 0.0)
        })
      }
      promise.resolve(arr)
    }
  }

  /**
   * Zips a session (split into ≤18 MB parts) and opens the share sheet with all
   * parts attached. [extraLog] is added to part 1 as app-log.txt.
   */
  @ReactMethod
  fun shareRecording(id: String, extraLog: String, promise: Promise) {
    Thread {
      try {
        val dir = File(SessionRecorder.root(ctx), id)
        if (!dir.isDirectory) throw IllegalArgumentException("No session $id")
        if (id == rec.id) throw IllegalStateException("Stop the recording before sharing it")
        val parts = SessionRecorder.zipParts(
          dir, File(ctx.cacheDir, "debug/share"), mapOf("app-log.txt" to extraLog),
        )
        val uris = ArrayList(parts.map {
          FileProvider.getUriForFile(ctx, "${ctx.packageName}.debuglog", it)
        })
        val mb = parts.sumOf { it.length() } / 1e6
        val send = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
          type = "application/zip"
          putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
          putExtra(Intent.EXTRA_SUBJECT, "OBD App recording $id")
          putExtra(
            Intent.EXTRA_TEXT,
            "Recording $id: ${parts.size} zip part(s), %.1f MB total.\n".format(mb) +
              "Part 1 has meta.json, events.log, gps.csv and app-log.txt; " +
              "remaining parts hold imu_NNN.csv (10 min each).",
          )
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, "Send recording").apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        (ctx.currentActivity ?: ctx).startActivity(chooser)
        promise.resolve(Arguments.createMap().apply {
          putInt("parts", parts.size)
          putDouble("mb", mb)
        })
      } catch (e: Exception) {
        promise.reject("SHARE_FAILED", e.message, e)
      }
    }.start()
  }

  /**
   * M4 replay: reads a finished session for JS. Resolves {meta, gps, imu} as
   * text; imu keeps only accel (a) and rotation (r) rows from every chunk,
   * which is all the estimators need, to halve what crosses the bridge.
   */
  @ReactMethod
  fun loadRecording(id: String, promise: Promise) {
    Thread {
      try {
        val dir = File(SessionRecorder.root(ctx), id)
        if (!SAFE_ID.matches(id) || !dir.isDirectory) throw IllegalArgumentException("No session $id")
        val imu = StringBuilder("t,s,x,y,z,w\n")
        dir.listFiles { f -> f.name.startsWith("imu_") }!!.sortedBy { it.name }.forEach { f ->
          f.forEachLine { l ->
            val c = l.indexOf(',')
            if (c > 0 && c + 2 < l.length && l[c + 2] == ',' && (l[c + 1] == 'a' || l[c + 1] == 'r')) {
              imu.append(l).append('\n')
            }
          }
        }
        fun read(n: String) = File(dir, n).takeIf { it.exists() }?.readText() ?: ""
        promise.resolve(Arguments.createMap().apply {
          putString("meta", read("meta.json"))
          putString("gps", read("gps.csv"))
          putString("imu", imu.toString())
        })
      } catch (e: Throwable) {
        promise.reject("LOAD_FAILED", e.message, e)
      }
    }.start()
  }

  /**
   * M4 export: writes [files] (name → text) into the session's exports/ folder
   * and opens the share sheet with all of them attached.
   */
  @ReactMethod
  fun shareExports(id: String, files: ReadableMap, promise: Promise) {
    Thread {
      try {
        if (!SAFE_ID.matches(id)) throw IllegalArgumentException("Bad id $id")
        val out = File(ctx.cacheDir, "debug/export").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val keep = File(File(SessionRecorder.root(ctx), id), "exports").apply { mkdirs() }
        val uris = ArrayList<android.net.Uri>()
        val it = files.keySetIterator()
        while (it.hasNextKey()) {
          val name = it.nextKey()
          if (!SAFE_FILE.matches(name)) throw IllegalArgumentException("Bad file name $name")
          val text = files.getString(name) ?: ""
          File(keep, name).writeText(text)
          val f = File(out, name).apply { writeText(text) }
          uris += FileProvider.getUriForFile(ctx, "${ctx.packageName}.debuglog", f)
        }
        val send = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
          type = "*/*"
          putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
          putExtra(Intent.EXTRA_SUBJECT, "OBD App session $id export")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, "Export session").apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        (ctx.currentActivity ?: ctx).startActivity(chooser)
        promise.resolve(uris.size)
      } catch (e: Throwable) {
        promise.reject("EXPORT_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun deleteRecording(id: String, promise: Promise) {
    handler.post {
      if (id == rec.id) {
        promise.reject("ACTIVE", "Cannot delete the session being recorded")
      } else {
        promise.resolve(File(SessionRecorder.root(ctx), id).deleteRecursively())
      }
    }
  }

  // Required by NativeEventEmitter.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  override fun invalidate() {
    handler.post {
      rec.stop(JSONObject().put("stopReason", "react instance invalidated"))
      stopInternal()
      thread.quitSafely()
    }
    super.invalidate()
  }

  private fun stopInternal() {
    sm.unregisterListener(this)
    lm.removeUpdates(gpsListener)
    lm.unregisterGnssStatusCallback(gnss)
    handler.removeCallbacks(flush)
    handler.removeCallbacks(health)
    running = false
    synchronized(lock) { acc.clear(); gyr.clear(); mag.clear(); rot.clear(); gpsBuf.clear() }
  }

  private fun hasLocationPermission() =
    ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  @SuppressLint("MissingPermission")
  private fun startGps() {
    if (!hasLocationPermission()) return
    try {
      lm.registerGnssStatusCallback(gnss, handler)
      lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, gpsListener, thread.looper)
    } catch (e: Exception) {
      rec.event("gps start failed: ${e.message}")
    }
  }

  private fun setKeepScreenOn(on: Boolean) {
    // Android throttles or stops sensors for backgrounded apps; keep the screen on.
    ctx.currentActivity?.runOnUiThread {
      val w = ctx.currentActivity?.window ?: return@runOnUiThread
      if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  override fun onSensorChanged(e: SensorEvent) {
    val t = (e.timestamp - t0Ns) / 1e9
    val v = e.values
    val i = when (e.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> 0
      Sensor.TYPE_GYROSCOPE -> 1
      Sensor.TYPE_MAGNETIC_FIELD -> 2
      Sensor.TYPE_ROTATION_VECTOR -> 3
      else -> return
    }
    winCount[i]++
    if (lastT[i] >= 0) winMaxGap[i] = maxOf(winMaxGap[i], t - lastT[i])
    lastT[i] = t
    if (i == 3) {
      SensorManager.getQuaternionFromVector(quat, v) // w, x, y, z
      rec.imu(t, 'r', quat[1], quat[2], quat[3], quat[0])
    } else {
      rec.imu(t, "agm"[i], v[0], v[1], v[2])
    }
    synchronized(lock) {
      when (i) {
        0 -> push(acc, t, v)
        1 -> push(gyr, t, v)
        2 -> push(mag, t, v)
        3 -> {
          rot.add(t); rot.add(quat[1].toDouble()); rot.add(quat[2].toDouble())
          rot.add(quat[3].toDouble()); rot.add(quat[0].toDouble())
        }
      }
    }
  }

  override fun onAccuracyChanged(s: Sensor, accuracy: Int) {
    if (s.type == Sensor.TYPE_MAGNETIC_FIELD) magAccuracy = accuracy
    rec.event("accuracy ${s.name} -> $accuracy")
  }

  private fun push(list: ArrayList<Double>, t: Double, v: FloatArray) {
    list.add(t); list.add(v[0].toDouble()); list.add(v[1].toDouble()); list.add(v[2].toDouble())
  }

  private fun emitBatch() {
    if (!ctx.hasActiveReactInstance()) return
    val ev = Arguments.createMap()
    synchronized(lock) {
      ev.putArray("acc", toArray(acc)); acc = ArrayList(acc.size)
      ev.putArray("gyr", toArray(gyr)); gyr = ArrayList(gyr.size)
      ev.putArray("mag", toArray(mag)); mag = ArrayList(mag.size)
      ev.putArray("rot", toArray(rot)); rot = ArrayList(rot.size)
      ev.putArray("gps", toArray(gpsBuf)); gpsBuf = ArrayList()
    }
    ev.putInt("magAccuracy", magAccuracy)
    ev.putInt("sats", sats)
    if (rec.active) {
      ev.putMap("recording", Arguments.createMap().apply {
        putString("id", rec.id)
        putDouble("elapsedS", rec.nowT())
        putDouble("bytes", rec.bytes.toDouble())
        putDouble("accRows", rec.rows[0].toDouble())
        putDouble("gpsFixes", rec.gpsFixes.toDouble())
      })
    }
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("imuBatch", ev)
  }

  private fun sensorInfoJson() = JSONObject().apply {
    for ((key, type) in TYPES) {
      put(key, sm.getDefaultSensor(type)?.let {
        JSONObject().apply {
          put("name", it.name); put("vendor", it.vendor); put("version", it.version)
          put("maxHz", maxHz(it)); put("resolution", it.resolution.toDouble())
          put("maxRange", it.maximumRange.toDouble())
        }
      } ?: JSONObject.NULL)
    }
    put("gpsPermission", hasLocationPermission())
    put("sdk", Build.VERSION.SDK_INT)
  }

  private fun toArray(list: List<Double>): WritableArray =
    Arguments.createArray().apply { list.forEach { pushDouble(it) } }

  companion object {
    const val BATCH_MS = 100L
    const val HEALTH_MS = 5000L
    /** Session ids and export names from JS: no path separators or "..". */
    val SAFE_ID = Regex("^rec-[0-9T-]+$")
    val SAFE_FILE = Regex("^[A-Za-z0-9._-]+$")
    // minDelay is µs between samples; 0 means on-change only.
    fun maxHz(s: Sensor) = if (s.minDelay > 0) 1e6 / s.minDelay else 0.0
    val TYPES = listOf(
      "acc" to Sensor.TYPE_ACCELEROMETER,
      "gyr" to Sensor.TYPE_GYROSCOPE,
      "mag" to Sensor.TYPE_MAGNETIC_FIELD,
      "rot" to Sensor.TYPE_ROTATION_VECTOR,
    )
  }
}

class SensorPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(SensorModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
