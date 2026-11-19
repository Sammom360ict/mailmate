package com.mailmate;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;

final class OtpJournal {
  private static final String KEY = "items";

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences("mailmate_otp_journal", Context.MODE_PRIVATE);
  }

  static synchronized JSONArray read(Context context) {
    try {
      return new JSONArray(preferences(context).getString(KEY, "[]"));
    } catch (org.json.JSONException ignored) {
      return new JSONArray();
    }
  }

  static synchronized boolean save(Context context, JSONObject item) throws IOException {
    JSONArray saved = read(context);
    for (int i = 0; i < saved.length(); i++) {
      if (item.optString("id").equals(saved.optJSONObject(i).optString("id"))) return false;
    }
    JSONArray next = new JSONArray().put(item);
    for (int i = 0; i < Math.min(saved.length(), 99); i++) next.put(saved.optJSONObject(i));
    if (!preferences(context).edit().putString(KEY, next.toString()).commit()) {
      throw new IOException("Could not save OTP");
    }
    return true;
  }

  static synchronized void markUsed(Context context, String id) {
    JSONArray saved = read(context);
    for (int i = 0; i < saved.length(); i++) {
      JSONObject item = saved.optJSONObject(i);
      if (!id.equals(item.optString("id"))) continue;
      try { item.put("used", true); } catch (org.json.JSONException ignored) { return; }
      preferences(context).edit().putString(KEY, saved.toString()).apply();
      return;
    }
  }

  static synchronized void removeAccount(Context context, String email) {
    JSONArray saved = read(context);
    JSONArray kept = new JSONArray();
    for (int i = 0; i < saved.length(); i++) {
      JSONObject item = saved.optJSONObject(i);
      if (!email.equals(item.optString("email"))) kept.put(item);
    }
    preferences(context).edit().putString(KEY, kept.toString()).apply();
  }
}
