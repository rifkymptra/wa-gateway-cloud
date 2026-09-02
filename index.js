const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason, Browsers } = require('@whiskeysockets/baileys'); 
const pino = require('pino'); 
const qrcode = require('qrcode-terminal'); 
const axios = require('axios'); 

async function connectToWhatsApp() {
    // Folder auth untuk menyimpan sesi[cite: 4]
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info'); 

    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false,  
        // Ubah 'info' jadi 'silent' agar terminal kembali bersih dari log JSON[cite: 4]
        logger: pino({ level: 'silent' }),  
        browser: Browsers.ubuntu('Chrome'),  
        syncFullHistory: false  
    });

    // Simpan sesi otomatis setiap ada pembaruan[cite: 4]
    sock.ev.on('creds.update', saveCreds); 

    // Pantau status koneksi[cite: 4]
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

    // Tangkap pesan masuk[cite: 4]
    sock.ev.on('messages.upsert', async m => { 
        const msg = m.messages[0]; 
        
        // Abaikan pesan dari diri sendiri atau broadcast status[cite: 4]
        if (!msg.message || msg.key.fromMe) return; 

        const remoteJid = msg.key.remoteJid; 
        const nomorPengirim = remoteJid.split('@')[0]; 

        // Ekstrak teks (bisa dari pesan biasa atau caption media)[cite: 4]
        const textMessage = msg.message.conversation ||  
                            msg.message.extendedTextMessage?.text ||  
                            msg.message.imageMessage?.caption ||  
                            msg.message.documentMessage?.caption || ''; 
        
        console.log(`\n📥 Pesan masuk dari ${nomorPengirim}: ${textMessage || '[Media/File]'}`); 

        if (textMessage.toUpperCase().startsWith('DAFTAR#')) { 
            const namaPegawai = textMessage.substring(7).trim(); // Mengambil teks setelah 'DAFTAR#'[cite: 4]
            
            if (!namaPegawai) { 
                await sock.sendMessage(remoteJid, { text: '⚠️ Format salah!\nKetik: *DAFTAR#Nama Anda*\nContoh: *DAFTAR#Budi*' }); 
                return; 
            }

            try { 
                console.log(`⏳ Mendaftarkan pegawai: ${namaPegawai}...`); 
                
                // Tembak ke route pendaftaran Laravel[cite: 4]
                const response = await axios.post('https://chatbot-cloud-k6nz.onrender.com/wa-register', { 
                    nomor: nomorPengirim, 
                    nama: namaPegawai 
                });

                if (response.data.status === 'success') { 
                    await sock.sendMessage(remoteJid, {  
                        text: `✅ Pendaftaran berhasil!\n\nNama: *${namaPegawai}*\n\nSekarang Anda sudah bisa mengirimkan dokumen atau gambar bukti dukung. Sistem akan otomatis menyimpannya ke dalam folder Drive pribadi Anda.`  
                    });
                    console.log(`✅ Berhasil mendaftarkan ${namaPegawai} ke database!`); // Tambahan feedback terminal
                } else if (response.data.status === 'exist') { 
                    await sock.sendMessage(remoteJid, {  
                        text: `⚠️ Nomor Anda sudah terdaftar di sistem. (${response.data.message})`  
                    });
                }
            } catch (err) { 
                console.error('❌ Gagal mendaftar ke Laravel:', err.message); 
                await sock.sendMessage(remoteJid, { text: '❌ Terjadi kesalahan sistem saat mendaftar. Pastikan Laravel sedang berjalan.' }); 
            }
            return; // Hentikan proses di sini agar tidak dilanjutkan ke webhook upload file[cite: 4]
        }

        let mediaData = null; 

        // Deteksi apakah pesan mengandung media[cite: 4]
        const messageType = Object.keys(msg.message)[0]; 
        const isMedia = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'].includes(messageType); 

        if (isMedia) {
            try {
                const mediaObj = msg.message[messageType];
                
                // --- BEST PRACTICE: Cek Ukuran File Sebelum Diunduh ---
                // fileLength bisa berupa angka atau objek Long, kita konversi ke Number lalu ke MB
                const fileSizeInBytes = Number(mediaObj.fileLength || 0);
                const fileSizeInMB = (fileSizeInBytes / (1024 * 1024)).toFixed(2);

                const MAX_FILE_SIZE_MB = 20; // Batas maksimal 20 MB

                if (fileSizeInMB > MAX_FILE_SIZE_MB) {
                    console.log(`⚠️ File ditolak: Ukuran ${fileSizeInMB} MB melebihi batas.`);
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ *File Terlalu Besar!*\n\nUkuran dokumen/foto yang Anda kirim adalah *${fileSizeInMB} MB*. Maksimal ukuran yang diizinkan sistem adalah *${MAX_FILE_SIZE_MB} MB*.\n\nSilakan kompres file Anda terlebih dahulu.` 
                    });
                    return; // Hentikan proses agar bot tidak capek mendownload file raksasa
                }
                // ------------------------------------------------------

                console.log('⏳ Mengunduh media via Baileys...');
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage
                });
                
                // (Lanjutan kode penamaan cerdas milikmu tetap di sini...)
                let captionName = textMessage ? textMessage.substring(0, 40).replace(/[^a-zA-Z0-9 ]/g, "") : null;
                let defaultName = 'Berkas';
                if (messageType === 'imageMessage') defaultName = 'Foto';
                if (messageType === 'videoMessage') defaultName = 'Video';

                let finalFileName = mediaObj.fileName || captionName || defaultName;
                
                mediaData = {
                    mimetype: mediaObj.mimetype,
                    data: buffer.toString('base64'),
                    filename: finalFileName
                };
                
                console.log(`✅ Media berhasil diunduh! Nama: ${finalFileName}, Ukuran: ${(buffer.length / 1024).toFixed(1)} KB`);
            } catch (err) {
                console.error('❌ Gagal mengunduh media:', err.message);
            }
        }

        // Kirim ke Webhook Laravel[cite: 4]
        try { 
            console.log('⏳ Mengirim ke Laravel...'); 
            const response = await axios.post('https://chatbot-cloud-k6nz.onrender.com/wa-webhook', { 
                nomor: nomorPengirim, 
                pesan: textMessage, 
                media: mediaData 
            }, { 
                maxBodyLength: Infinity, 
                maxContentLength: Infinity, 
                timeout: 30000  
            });

            console.log('🚀 Berhasil kirim ke Laravel'); 

            // --- BACA INSTRUKSI BALASAN DARI LARAVEL ---
            if (response.data && response.data.status === 'reply' && response.data.reply_message) {
                await sock.sendMessage(remoteJid, { text: response.data.reply_message });
                console.log(`🤖 Membalas ke user: ${response.data.reply_message.substring(0, 30)}...`);
            }
            
            // --- TAMBAHAN BARU UNTUK MENU 3 (FILE EXCEL) ---
            if (response.data && response.data.status === 'document') {
                console.log(`📤 Mengirim dokumen ${response.data.file_name} ke pengguna...`);
                const fileBuffer = Buffer.from(response.data.document_data, 'base64');
                
                await sock.sendMessage(remoteJid, {
                    document: fileBuffer,
                    mimetype: response.data.mimetype,
                    fileName: response.data.file_name,
                    caption: response.data.reply_message
                });
            }
            // --------------------------------------------------------

        } catch (error) { 
            if (error.response) { 
                console.error('❌ Gagal kirim ke Laravel. Status:', error.response.status, '| Response:', JSON.stringify(error.response.data)); 
            } else { 
                console.error('❌ Gagal kirim ke Laravel:', error.message); 
            }
        }
    });
}

connectToWhatsApp(); 