package com.mailmate;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.mail.Message;
import javax.mail.Multipart;
import javax.mail.Part;

final class MailParser {
  private static final Pattern OTP = Pattern.compile("(?<!\\d)(\\d{4,8})(?!\\d)");
  private static final Pattern CONTEXT_FIRST = Pattern.compile(
    "(?is)(?:verification|security|one[- ]time|login|sign[- ]in|confirmation|authentication|auth|otp|passcode|pin|code)(?:\\s+(?:code|number|password))?[^\\d]{0,40}(\\d{4,8})(?!\\d)");
  private static final Pattern CONTEXT_AFTER = Pattern.compile(
    "(?is)(\\d{4,8})(?!\\d)[^\\p{Alnum}]{0,20}(?:is your|is the|as your)?\\s*(?:verification|security|one[- ]time|login|sign[- ]in|confirmation|authentication|auth|otp|passcode|pin)\\b");
  private MailParser() {}

  static String code(Message message) throws Exception {
    String subject = message.getSubject() == null ? "" : message.getSubject();
    String text = (subject + " " + body(message)).replaceAll("(?is)<[^>]+>", " ").replace("&nbsp;", " ");
    Matcher matcher = CONTEXT_FIRST.matcher(text);
    if (matcher.find()) return matcher.group(1);
    matcher = CONTEXT_AFTER.matcher(text);
    if (matcher.find()) return matcher.group(1);
    matcher = OTP.matcher(text);
    return matcher.find() ? matcher.group(1) : null;
  }

  static String body(Object part) throws Exception {
    if (part instanceof Message) return body(((Message) part).getContent());
    if (part instanceof Multipart) {
      Multipart multi = (Multipart) part;
      StringBuilder out = new StringBuilder();
      for (int i = 0; i < multi.getCount(); i++) out.append(body(multi.getBodyPart(i)));
      return out.toString();
    }
    if (part instanceof Part) {
      Object content = ((Part) part).getContent();
      return content instanceof String ? (String) content : body(content);
    }
    return part instanceof String ? (String) part : "";
  }
}
