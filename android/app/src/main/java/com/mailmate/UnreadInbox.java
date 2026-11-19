package com.mailmate;

import javax.mail.Flags;
import javax.mail.Folder;
import javax.mail.Message;
import javax.mail.Store;
import javax.mail.search.FlagTerm;

final class UnreadInbox {
  private static final FlagTerm UNREAD = new FlagTerm(new Flags(Flags.Flag.SEEN), false);

  interface Processor {
    void process(Message[] messages) throws Exception;
  }

  private UnreadInbox() {}

  static void scan(Store store, Processor processor) throws Exception {
    // Each SELECT refreshes JavaMail's message count and sequence-number cache.
    Folder inbox = store.getFolder("INBOX");
    inbox.open(Folder.READ_WRITE);
    try {
      processor.process(inbox.search(UNREAD));
    } finally {
      if (inbox.isOpen()) inbox.close(false);
    }
  }
}
