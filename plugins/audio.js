const ffmpeg = require('fluent-ffmpeg');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cleanup = f => { try { if (f) fs.unlinkSync(f); } catch {} };

async function downloadAudio(sock, quotedMsg) {
  const msgType = Object.keys(quotedMsg.message)[0];
  const stream = await downloadContentFromMessage(quotedMsg.message[msgType], 'audio');
  let buf = Buffer.from([]);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf;
}

async function applyEffect(inputBuffer, effect) {
  const id = `${Date.now()}_${require('crypto').randomBytes(6).toString('hex')}`;
  const inp = path.join(os.tmpdir(), `shadow_in_${id}.mp3`);
  const out = path.join(os.tmpdir(), `shadow_out_${id}.mp3`);

  const filters = {
    deep: 'asetrate=44100*0.9,atempo=1.1',
    bass: 'bass=g=10',
    robot: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
    earrape: 'volume=20',
    chipmunk: 'asetrate=44100*1.5,atempo=1.5',
    nightcore: 'asetrate=44100*1.25,atempo=1.25',
    reverse: 'areverse',
    slow: 'atempo=0.8',
    fast: 'atempo=1.5',
    baby: 'asetrate=44100*1.8,atempo=1.8',
    demon: 'asetrate=44100*0.8,atempo=1.2',
    smooth: 'bass=g=5,treble=g=-5',
    fat: 'bass=g=15,treble=g=5',
    blown: 'volume=30',
    radio: 'highpass=f=200,lowpass=f=3000,volume=10',
    tupai: 'volume=5'
  };

  try {
    fs.writeFileSync(inp, inputBuffer, { flag: 'wx' });
    await new Promise((resolve, reject) => {
      ffmpeg(inp).audioFilter(filters[effect] || 'volume=1').output(out)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    return { outPath: out, inputPath: inp };
  } catch (error) {
    cleanup(inp);
    cleanup(out);
    throw error;
  }
}

const effects = ['deep','bass','robot','earrape','chipmunk','nightcore','reverse','slow','fast','baby','demon','smooth','fat','blown','tupai','radio'];

module.exports = effects.map(effect => ({
  command: effect,
  category: "audio",
  execute: async (s, m, { reply }) => {
    if (!m.quoted?.message) return reply("❌ Reply to a voice note or audio!");
    const msgType = Object.keys(m.quoted.message)[0];
    if (msgType !== 'audioMessage' && msgType !== 'voiceMessage') return reply("❌ Reply to an audio/voice note!");
    reply(`🎛️ Applying ${effect} effect...`);
    let files;
    try {
      const buf = await downloadAudio(s, m.quoted);
      files = await applyEffect(buf, effect);
      await s.sendMessage(m.chat, { audio: fs.readFileSync(files.outPath), mimetype: 'audio/mpeg', ptt: true }, { quoted: m });
    } catch (e) {
      reply("❌ Failed: " + e.message);
    } finally {
      cleanup(files?.inputPath);
      cleanup(files?.outPath);
    }
  }
}));
