/* Cursus CoS email ingest adapters.
   An adapter turns one incoming message (in the provider's own shape) into a task draft.
   Today only the Microsoft Graph / Exchange mapping exists. The thing that FETCHES mail
   (a Graph poller in the Windows app's main process, or a relay service) is not built yet;
   whatever it is, it just calls CoS.api.ingestEmails(messages, 'exchange'). */
(function () {
  'use strict';
  const CoS = (window.CoS = window.CoS || {});

  const adapters = {
    exchange: {
      name: 'Microsoft Exchange',
      toTask(m, cfg){
        if (!m || !m.id) return null;
        const flagged = m.flag && m.flag.flagStatus === 'flagged';
        if (cfg.onlyFlagged && !flagged) return null;
        const from = m.from && m.from.emailAddress ? m.from.emailAddress : {};
        const dueRaw = cfg.mapFlagDue && m.flag && m.flag.dueDateTime && m.flag.dueDateTime.dateTime;
        const startRaw = cfg.mapFlagDue && m.flag && m.flag.startDateTime && m.flag.startDateTime.dateTime;
        const tags = ['email'].concat(cfg.mapCategories ? (m.categories || []).map(x => String(x).toLowerCase()) : []);
        return {
          title: (m.subject || '(no subject)').slice(0, 200),
          description: `From: ${from.name || ''} <${from.address || 'unknown'}>\n\n${m.bodyPreview || ''}`.trim(),
          priority: cfg.mapImportance && m.importance === 'high' ? 'high' : cfg.mapImportance && m.importance === 'low' ? 'low' : 'medium',
          due: dueRaw ? dueRaw.slice(0, 10) : '', start: startRaw ? startRaw.slice(0, 10) : '',
          tags: [...new Set(tags)],
          external: { source: 'exchange', id: m.id, conversationId: m.conversationId || '', webLink: m.webLink || '', from: from.name || from.address || '', received: m.receivedDateTime || '' }
        };
      }
    }
  };

  function sampleMail(addDays, todayStr){
    const d = n => addDays(todayStr(), n);
    return { id: 'AAMkAGI2-sample-001', subject: 'Please review the revised SOW by Friday', bodyPreview: 'Hi team, attached is the revised statement of work for the managed services renewal. Pricing in section 4 has changed.',
      receivedDateTime: new Date().toISOString(), importance: 'high', isRead: false,
      flag: { flagStatus: 'flagged', dueDateTime: { dateTime: d(3) + 'T17:00:00.0000000', timeZone: 'UTC' } }, categories: ['Contracts', 'Finance'],
      from: { emailAddress: { name: 'Dana Whitfield', address: 'dana.whitfield@contoso.com' } }, webLink: 'https://outlook.office.com/mail/', conversationId: 'AAQkAGI2-conv-001', hasAttachments: true };
  }

  CoS.ingest = { adapters, sampleMail };
})();
