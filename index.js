const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

async function connectToWhatsApp() {
    // Folder auth untuk menyimpan sesi
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
        // Ubah 'info' jadi 'silent' agar terminal kembali bersih dari log JSON
        logger: pino({ level: 'silent' }), 
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false 
    });

    // Simpan sesi otomatis setiap ada pembaruan
    sock.ev.on('creds.update', saveCreds);

    // Pantau status koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n>>> SILAKAN SCAN QR CODE DI BAWAH INI <<<');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`\nKoneksi terputus. Status Code: ${statusCode} | Mencoba reconnect: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Sesi ditolak oleh server WA. Silakan HAPUS folder baileys_auth_info lalu jalankan ulang node index.js');
            }
        } else if (connection === 'open') {
            console.log('\n✅ WhatsApp Bot Ready (Powered by Baileys)!\n');
        }
    });

    // Tangkap pesan masuk
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        
        // Abaikan pesan dari diri sendiri atau broadcast status
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const nomorPengirim = remoteJid.split('@')[0];

        // Ekstrak teks (bisa dari pesan biasa atau caption media)
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            msg.message.imageMessage?.caption || 
                            msg.message.documentMessage?.caption || '';
        
        console.log(`\n📥 Pesan masuk dari ${nomorPengirim}: ${textMessage || '[Media/File]'}`);

        if (textMessage.toUpperCase().startsWith('DAFTAR#')) {
            const namaPegawai = textMessage.substring(7).trim(); // Mengambil teks setelah 'DAFTAR#'
            
            if (!namaPegawai) {
                await sock.sendMessage(remoteJid, { text: '⚠️ Format salah!\nKetik: *DAFTAR#Nama Anda*\nContoh: *DAFTAR#Budi*' });
                return;
            }

            try {
                console.log(`⏳ Mendaftarkan pegawai: ${namaPegawai}...`);
                
                // Tembak ke route pendaftaran Laravel
                const response = await axios.post('http://127.0.0.1:8000/wa-register', {
                    nomor: nomorPengirim,
                    nama: namaPegawai
                });

                if (response.data.status === 'success') {
                    await sock.sendMessage(remoteJid, { 
                        text: `✅ Pendaftaran berhasil!\n\nNama: *${namaPegawai}*\n\nSekarang Anda sudah bisa mengirimkan dokumen atau gambar bukti dukung. Sistem akan otomatis menyimpannya ke dalam folder Drive pribadi Anda.` 
                    });
                } else if (response.data.status === 'exist') {
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ Nomor Anda sudah terdaftar di sistem. (${response.data.message})` 
                    });
                }
            } catch (err) {
                console.error('❌ Gagal mendaftar ke Laravel:', err.message);
                await sock.sendMessage(remoteJid, { text: '❌ Terjadi kesalahan sistem saat mendaftar. Pastikan Laravel sedang berjalan.' });
            }
            return; // Hentikan proses di sini agar tidak dilanjutkan ke webhook upload file
        }

        let mediaData = null;

        // Deteksi apakah pesan mengandung media
        const messageType = Object.keys(msg.message)[0];
        const isMedia = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'].includes(messageType);

        if (isMedia) {
            try {
                console.log('⏳ Mengunduh media via Baileys...');
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage
                });

                const mediaObj = msg.message[messageType];
                
                mediaData = {
                    mimetype: mediaObj.mimetype,
                    data: buffer.toString('base64'),
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
            console.log('⏳ Mengirim ke Laravel...');
            await axios.post('http://127.0.0.1:8000/wa-webhook', {
                nomor: nomorPengirim,
                pesan: textMessage,
                media: mediaData
            }, {
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