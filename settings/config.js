// SHADOW X MD configuration
const fs = require('fs');

const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');

const config = {
    owner: OWNER_NUMBER ? [OWNER_NUMBER] : [],
    botNumber: OWNER_NUMBER,
    setPair: 'SHADOW-X-MD',
    thumbUrl: 'https://raw.githubusercontent.com/castro343/shadow-X-MD/main/thumbnail/image.jpg',
    session: 'sessions',
    mode: process.env.BOT_MODE || 'public',
    auto: { read: false, typing: false, react: false, antidelete: false },
    status: { public: true, terminal: true, reactsw: false },
    message: {
        owner: 'This command is reserved for the SHADOW owner.',
        group: 'This command works in groups only.',
        admin: 'Only group admins can use this command.',
        private: 'This command works in private chat only.'
    },
    settings: {
        title: 'SHADOW X MD',
        description: 'SHADOW X MD WhatsApp automation bot',
        footer: 'POWERED BY SHADOW',
        menuSongUrl: ''
    },
    newsletter: {
        name: process.env.NEWSLETTER_NAME || 'SHADOW X MD',
        inviteCode: process.env.NEWSLETTER_INVITE_CODE || '0029Vb9e130F6sn68hFZQN3x',
        id: process.env.NEWSLETTER_ID || ''
    }
};

module.exports = config;

const file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(__filename + ' updated!');
    delete require.cache[file];
    require(file);
});
