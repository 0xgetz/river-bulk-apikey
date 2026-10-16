# TODO

- [x] Posta arka uçları sağlamlaştırıldı (`src/mailtrap.js`: raw-EML yedeği, 204/`ETIMEDOUT` dayanıklılığı, `subjectIncludes`)
- [x] Proxy katmanı iyileştirildi (`src/proxy.js`), temp-mail.org 403 mesajı gerçeği yansıtır hale getirildi (`src/tempmailorg.js`)
- [x] `tools/inbox-factory.js` — arka uç seçilebilir kutu fabrikası (mailtrap/emailnator/tempmailorg)
- [x] 9Router connector (`src/connect-9router.js`) + README bölümü
- [ ] 9Router'da `river` node'una üretilen key'leri toplu bağlayan bir `--connect-all` akışı (çoklu key için isimlendirme `river-001…`)
- [ ] `--mailbox tempmailorg` kullanımını README'ye örnek olarak ekle (tarayıcı-içi okuyucu; Cloudflare nedeniyle Node'dan okunamaz)
- [ ] i18n dosyalarını yeni seçeneklerle senkronla (`--mail-address`, `--mail-alias`, `--mail-exit`)

Şemsiye plan: `../TODO.md`
