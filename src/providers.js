import Xmlb from 'gi://Xmlb';

import { ImapClient } from './imap.js';

const googleProvider = {
    getApiURL(priorityOnly) {
        const label = priorityOnly ? '%5Eiim' : '%5Ei';
        return `https://mail.google.com/mail/feed/atom/${label}`;
    },

    getFallbackURL() {
        return 'https://mail.google.com';
    },

    parseResponse(body, mailbox) {
        const xml = body.replace(/xmlns="[^"]*"/g, '');

        const builder = new Xmlb.Builder();
        const source = new Xmlb.BuilderSource();
        source.load_xml(xml, Xmlb.BuilderSourceFlags.NONE);
        builder.import_source(source);
        const silo = builder.compile(Xmlb.BuilderCompileFlags.NONE, null);

        let entries;
        try {
            entries = silo.query('feed/entry', null);
        } catch {
            return [];
        }

        return entries.map((entry) => {
            const href = entry.query_attr('link', 'href');
            return {
                id: entry.query_text('id'),
                subject: entry.query_text('title') || '',
                from: `${entry.query_text('author/name') || ''} <${entry.query_text('author/email') || ''}>`,
                link: href ? `${href}&authuser=${mailbox}` : null,
            };
        });
    },
};

const microsoftProvider = {
    getApiURL(priorityOnly) {
        const filter = priorityOnly
            ? "isRead eq false and inferenceClassification eq 'focused'"
            : 'isRead eq false';
        return `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=${filter}&$select=from,subject,webLink,id`;
    },

    getFallbackURL() {
        return 'https://outlook.live.com';
    },

    parseResponse(body) {
        const data = JSON.parse(body);
        return (data.value || []).map((msg) => {
            const addr = msg.from?.emailAddress;
            return {
                id: msg.id,
                subject: msg.subject || '',
                from: addr ? `${addr.name} <${addr.address}>` : '',
                link: msg.webLink,
            };
        });
    },
};

const imapProvider = {
    // IMAP provider works differently - it needs to establish a connection
    // and doesn't use REST API calls
    async fetchMessages({ host, port, username, password, useTls, cancellable, logger }) {
        const client = new ImapClient({
            host,
            port,
            username,
            password,
            useTls,
            cancellable,
            logger,
        });

        try {
            await client.connect();
            await client.selectMailbox('INBOX');
            const unreadIds = await client.searchUnread();
            const messages = await client.fetchMessages(unreadIds);
            await client.logout();
            return messages;
        } catch (err) {
            await client.logout();
            throw err;
        }
    },

    getFallbackURL() {
        return null; // IMAP doesn't have a web interface
    },
};

export const providers = {
    google: googleProvider,
    ms_graph: microsoftProvider,
    imap_smtp: imapProvider,
};
