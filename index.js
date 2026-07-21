const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

async function connectToWhatsApp() {
    // Folder auth baru untuk Baileys
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Kita matikan bawaan, pakai qrcode-terminal aja biar rapi
        logger: pino({ level: 'silent' }), // Matikan log bawaan Baileys yang terlalu ramai
        browser: ['Bot Webhook Laravel', 'Chrome', '1.0.0']
    });

    // Simpan sesi otomatis setiap ada pembaruan
    sock.ev.on('creds.update', saveCreds);

    // Pantau status koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba reconnect...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot Ready (Powered by Baileys)!');
        }
    });

    // Tangkap pesan masuk
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        
        // Abaikan pesan dari diri sendiri atau broadcast status
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const nomorPengirim = remoteJid.split('@')[0]; // Ambil nomornya saja

        // Ekstrak teks (bisa dari pesan biasa atau caption media)
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.documentMessage?.caption || '';
        
        console.log(`\nPesan masuk dari ${nomorPengirim}: ${textMessage || '[Media/File]'}`);

        let mediaData = null;

        // Deteksi apakah pesan mengandung media (gambar/dokumen/video/audio)
        const messageType = Object.keys(msg.message)[0];
        const isMedia = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'].includes(messageType);

        if (isMedia) {
            try {
                console.log('Mengunduh media via Baileys...');
                // Baileys langsung download buffer file tanpa perlu buka browser!
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage
                });

                const mediaObj = msg.message[messageType];
                
                mediaData = {
                    mimetype: mediaObj.mimetype,
                    data: buffer.toString('base64'), // Konversi ke base64 untuk dikirim ke Laravel
                    filename: mediaObj.fileName || 'dokumen_tanpa_nama'
                };
                
                const sizeKB = (buffer.length / 1024).toFixed(1);
                console.log(`✅ Media berhasil diunduh! Tipe: ${mediaObj.mimetype}, Ukuran: ${sizeKB} KB`);
            } catch (err) {
                console.error('❌ Gagal mengunduh media:', err.message);
            }
        }

        // Kirim ke Webhook Laravel
        try {
            await axios.post('http://127.0.0.1:8000/wa-webhook', {
                nomor: nomorPengirim,
                pesan: textMessage,
                media: mediaData
            }, {
                // Konfigurasi andalan agar file besar tidak dicegat axios
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: 30000 
            });

            console.log('🚀 Berhasil kirim ke Laravel');
        } catch (error) {
            if (error.response) {
                console.error('❌ Gagal kirim ke Laravel. Status:', error.response.status, '| Response:', JSON.stringify(error.response.data));
            } else {
                console.error('❌ Gagal kirim ke Laravel:', error.message);
            }
        }
    });
}

// Mulai bot
connectToWhatsApp();