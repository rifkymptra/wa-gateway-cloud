const { Client, LocalAuth } = require('whatsapp-web.js'); // tambah LocalAuth
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const client = new Client({
    authStrategy: new LocalAuth() // ← tambahkan ini
})

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Bot Ready!');
});

client.on('message', async message => {

    console.log('Pesan masuk:', message.body);

    let mediaData = null;

    if (message.hasMedia) {

        const media = await message.downloadMedia();

        mediaData = {
            mimetype: media.mimetype,
            data: media.data,
            filename: media.filename
        };

        console.log('Media terdeteksi!');
    }

    try {

        await axios.post('http://127.0.0.1:8000/wa-webhook', {
            nomor: message.from,
            pesan: message.body,
            media: mediaData
        });

        console.log('Berhasil kirim ke Laravel');

    } catch (error) {

        console.log('Gagal kirim:', error.message);

    }

});

client.initialize();