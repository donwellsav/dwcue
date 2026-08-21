import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TRANSLATIONS = {
  en: {
    title: 'Configure Controls', shortcutBtn: 'Shortcuts',
    tabKeyboard: 'Keyboard', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionOneShots: 'One Shots', sectionPlayback: 'Playback', sectionVolume: 'Volume',
    cartSlot: 'One Shot {n}', oneShot: 'One Shot {n}', pauseResume: 'Pause / Resume', toggleLoop: 'Toggle Loop',
    stopAll: 'Stop All', selectUp: 'Select Up', selectDown: 'Select Down',
    playSelected: 'Play Selected', masterVolume: 'Master Volume',
    midiDevice: 'MIDI Device', allDevices: 'All Devices',
    conflictSlot: 'Already assigned to One Shot {n}', conflictOneShot: 'Already assigned to One Shot {n}', conflictAction: 'Already assigned to {action}',
    pressAnyKey: 'Press any key...', reserved: 'This key combination is reserved',
    resetKeyboard: 'Reset to Defaults', resetMidi: 'Reset All', close: 'Close',
    clear: 'Clear', learn: 'Learn', cancel: 'Cancel',
    waitingForInput: 'Waiting for MIDI input...', noDevices: 'No MIDI devices detected',
    reassign: 'Reassign', conflictMessage: 'This MIDI control is already assigned to "{action}". Reassign it?'
  },
  de: {
    title: 'Steuerung konfigurieren', shortcutBtn: 'Tastenkürzel',
    tabKeyboard: 'Tastatur', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Wiedergabe', sectionVolume: 'Lautstärke',
    cartSlot: 'One Shot {n}', pauseResume: 'Pause / Fortsetzen', toggleLoop: 'Schleife umschalten',
    stopAll: 'Alles stoppen', selectUp: 'Nach oben auswählen', selectDown: 'Nach unten auswählen',
    playSelected: 'Ausgewähltes abspielen', masterVolume: 'Hauptlautstärke',
    midiDevice: 'MIDI-Gerät', allDevices: 'Alle Geräte',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Bereits {action} zugewiesen',
    pressAnyKey: 'Beliebige Taste drücken...', reserved: 'Diese Tastenkombination ist reserviert',
    resetKeyboard: 'Auf Standardwerte zurücksetzen', resetMidi: 'Alle zurücksetzen', close: 'Schließen',
    clear: 'Löschen', learn: 'Lernen', cancel: 'Abbrechen',
    waitingForInput: 'Warte auf MIDI-Eingabe...', noDevices: 'Keine MIDI-Geräte erkannt',
    reassign: 'Neu zuweisen', conflictMessage: 'Diese MIDI-Steuerung ist bereits "{action}" zugewiesen. Neu zuweisen?'
  },
  fr: {
    title: 'Configurer les contrôles', shortcutBtn: 'Raccourcis',
    tabKeyboard: 'Clavier', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Lecture', sectionVolume: 'Volume',
    cartSlot: 'One Shot {n}', pauseResume: 'Pause / Reprendre', toggleLoop: 'Activer la boucle',
    stopAll: 'Tout arrêter', selectUp: 'Sélectionner vers le haut', selectDown: 'Sélectionner vers le bas',
    playSelected: 'Lire la sélection', masterVolume: 'Volume principal',
    midiDevice: 'Périphérique MIDI', allDevices: 'Tous les périphériques',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Déjà assigné à {action}',
    pressAnyKey: 'Appuyez sur une touche...', reserved: 'Cette combinaison de touches est réservée',
    resetKeyboard: 'Réinitialiser par défaut', resetMidi: 'Tout réinitialiser', close: 'Fermer',
    clear: 'Effacer', learn: 'Apprendre', cancel: 'Annuler',
    waitingForInput: "En attente d'entrée MIDI...", noDevices: 'Aucun périphérique MIDI détecté',
    reassign: 'Réassigner', conflictMessage: 'Ce contrôle MIDI est déjà assigné à "{action}". Réassigner?'
  },
  es: {
    title: 'Configurar controles', shortcutBtn: 'Atajos',
    tabKeyboard: 'Teclado', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Reproducción', sectionVolume: 'Volumen',
    cartSlot: 'One Shot {n}', pauseResume: 'Pausa / Reanudar', toggleLoop: 'Activar bucle',
    stopAll: 'Detener todo', selectUp: 'Seleccionar arriba', selectDown: 'Seleccionar abajo',
    playSelected: 'Reproducir seleccionado', masterVolume: 'Volumen principal',
    midiDevice: 'Dispositivo MIDI', allDevices: 'Todos los dispositivos',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Ya asignado a {action}',
    pressAnyKey: 'Presione cualquier tecla...', reserved: 'Esta combinación de teclas está reservada',
    resetKeyboard: 'Restablecer valores predeterminados', resetMidi: 'Restablecer todo', close: 'Cerrar',
    clear: 'Limpiar', learn: 'Aprender', cancel: 'Cancelar',
    waitingForInput: 'Esperando entrada MIDI...', noDevices: 'No se detectaron dispositivos MIDI',
    reassign: 'Reasignar', conflictMessage: 'Este control MIDI ya está asignado a "{action}". ¿Reasignar?'
  },
  it: {
    title: 'Configura controlli', shortcutBtn: 'Scorciatoie',
    tabKeyboard: 'Tastiera', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Riproduzione', sectionVolume: 'Volume',
    cartSlot: 'One Shot {n}', pauseResume: 'Pausa / Riprendi', toggleLoop: 'Attiva ciclo',
    stopAll: 'Ferma tutto', selectUp: 'Seleziona su', selectDown: 'Seleziona giù',
    playSelected: 'Riproduci selezionato', masterVolume: 'Volume principale',
    midiDevice: 'Dispositivo MIDI', allDevices: 'Tutti i dispositivi',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Già assegnato a {action}',
    pressAnyKey: 'Premi un tasto...', reserved: 'Questa combinazione di tasti è riservata',
    resetKeyboard: 'Ripristina impostazioni predefinite', resetMidi: 'Ripristina tutto', close: 'Chiudi',
    clear: 'Cancella', learn: 'Apprendi', cancel: 'Annulla',
    waitingForInput: 'In attesa di input MIDI...', noDevices: 'Nessun dispositivo MIDI rilevato',
    reassign: 'Riassegna', conflictMessage: 'Questo controllo MIDI è già assegnato a "{action}". Riassegnare?'
  },
  pt: {
    title: 'Configurar controles', shortcutBtn: 'Atalhos',
    tabKeyboard: 'Teclado', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Reprodução', sectionVolume: 'Volume',
    cartSlot: 'One Shot {n}', pauseResume: 'Pausar / Retomar', toggleLoop: 'Alternar loop',
    stopAll: 'Parar tudo', selectUp: 'Selecionar acima', selectDown: 'Selecionar abaixo',
    playSelected: 'Reproduzir selecionado', masterVolume: 'Volume principal',
    midiDevice: 'Dispositivo MIDI', allDevices: 'Todos os dispositivos',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Já atribuído a {action}',
    pressAnyKey: 'Pressione qualquer tecla...', reserved: 'Esta combinação de teclas está reservada',
    resetKeyboard: 'Restaurar padrões', resetMidi: 'Redefinir tudo', close: 'Fechar',
    clear: 'Limpar', learn: 'Aprender', cancel: 'Cancelar',
    waitingForInput: 'Aguardando entrada MIDI...', noDevices: 'Nenhum dispositivo MIDI detectado',
    reassign: 'Reatribuir', conflictMessage: 'Este controle MIDI já está atribuído a "{action}". Reatribuir?'
  },
  ru: {
    title: 'Настройка управления', shortcutBtn: 'Ярлыки',
    tabKeyboard: 'Клавиатура', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Воспроизведение', sectionVolume: 'Громкость',
    cartSlot: 'One Shot {n}', pauseResume: 'Пауза / Продолжить', toggleLoop: 'Переключить цикл',
    stopAll: 'Остановить всё', selectUp: 'Выбрать выше', selectDown: 'Выбрать ниже',
    playSelected: 'Воспроизвести выбранное', masterVolume: 'Основная громкость',
    midiDevice: 'MIDI-устройство', allDevices: 'Все устройства',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Уже назначено {action}',
    pressAnyKey: 'Нажмите любую клавишу...', reserved: 'Эта комбинация клавиш зарезервирована',
    resetKeyboard: 'Сбросить до умолчаний', resetMidi: 'Сбросить всё', close: 'Закрыть',
    clear: 'Очистить', learn: 'Обучить', cancel: 'Отмена',
    waitingForInput: 'Ожидание MIDI-сигнала...', noDevices: 'MIDI-устройства не обнаружены',
    reassign: 'Переназначить', conflictMessage: 'Этот MIDI-контроллер уже назначен "{action}". Переназначить?'
  },
  ja: {
    title: 'コントロール設定', shortcutBtn: 'ショートカット',
    tabKeyboard: 'キーボード', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: '再生', sectionVolume: '音量',
    cartSlot: 'One Shot {n}', pauseResume: '一時停止 / 再開', toggleLoop: 'ループ切替',
    stopAll: 'すべて停止', selectUp: '上に選択', selectDown: '下に選択',
    playSelected: '選択を再生', masterVolume: 'マスターボリューム',
    midiDevice: 'MIDIデバイス', allDevices: 'すべてのデバイス',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: '{action} に割り当て済み',
    pressAnyKey: '任意のキーを押してください...', reserved: 'このキーの組み合わせは予約済みです',
    resetKeyboard: 'デフォルトにリセット', resetMidi: 'すべてリセット', close: '閉じる',
    clear: 'クリア', learn: '学習', cancel: 'キャンセル',
    waitingForInput: 'MIDI入力待ち...', noDevices: 'MIDIデバイスが検出されません',
    reassign: '再割り当て', conflictMessage: 'このMIDIコントロールは既に「{action}」に割り当てられています。再割り当てしますか？'
  },
  zh: {
    title: '配置控制', shortcutBtn: '快捷键',
    tabKeyboard: '键盘', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: '播放', sectionVolume: '音量',
    cartSlot: 'One Shot {n}', pauseResume: '暂停 / 恢复', toggleLoop: '切换循环',
    stopAll: '全部停止', selectUp: '向上选择', selectDown: '向下选择',
    playSelected: '播放所选', masterVolume: '主音量',
    midiDevice: 'MIDI设备', allDevices: '所有设备',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: '已分配给 {action}',
    pressAnyKey: '按任意键...', reserved: '此键组合已被保留',
    resetKeyboard: '恢复默认值', resetMidi: '全部重置', close: '关闭',
    clear: '清除', learn: '学习', cancel: '取消',
    waitingForInput: '等待MIDI输入...', noDevices: '未检测到MIDI设备',
    reassign: '重新分配', conflictMessage: '此MIDI控制器已分配给"{action}"。重新分配？'
  },
  ko: {
    title: '컨트롤 설정', shortcutBtn: '단축키',
    tabKeyboard: '키보드', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: '재생', sectionVolume: '볼륨',
    cartSlot: 'One Shot {n}', pauseResume: '일시정지 / 재개', toggleLoop: '루프 전환',
    stopAll: '모두 중지', selectUp: '위로 선택', selectDown: '아래로 선택',
    playSelected: '선택 항목 재생', masterVolume: '마스터 볼륨',
    midiDevice: 'MIDI 장치', allDevices: '모든 장치',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: '{action}에 이미 할당됨',
    pressAnyKey: '아무 키나 누르세요...', reserved: '이 키 조합은 예약되어 있습니다',
    resetKeyboard: '기본값으로 재설정', resetMidi: '모두 재설정', close: '닫기',
    clear: '지우기', learn: '학습', cancel: '취소',
    waitingForInput: 'MIDI 입력 대기 중...', noDevices: 'MIDI 장치가 감지되지 않음',
    reassign: '재할당', conflictMessage: '이 MIDI 컨트롤은 이미 "{action}"에 할당되어 있습니다. 재할당하시겠습니까?'
  },
  ar: {
    title: 'تكوين الضوابط', shortcutBtn: 'اختصارات',
    tabKeyboard: 'لوحة المفاتيح', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'تشغيل', sectionVolume: 'الصوت',
    cartSlot: 'One Shot {n}', pauseResume: 'إيقاف مؤقت / متابعة', toggleLoop: 'تبديل التكرار',
    stopAll: 'إيقاف الكل', selectUp: 'اختيار للأعلى', selectDown: 'اختيار للأسفل',
    playSelected: 'تشغيل المحدد', masterVolume: 'الصوت الرئيسي',
    midiDevice: 'جهاز MIDI', allDevices: 'جميع الأجهزة',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'تم التعيين بالفعل لـ {action}',
    pressAnyKey: 'اضغط على أي مفتاح...', reserved: 'هذه المجموعة من المفاتيح محجوزة',
    resetKeyboard: 'إعادة التعيين للافتراضي', resetMidi: 'إعادة تعيين الكل', close: 'إغلاق',
    clear: 'مسح', learn: 'تعلم', cancel: 'إلغاء',
    waitingForInput: 'في انتظار إدخال MIDI...', noDevices: 'لم يتم اكتشاف أجهزة MIDI',
    reassign: 'إعادة التعيين', conflictMessage: 'عنصر تحكم MIDI هذا معين بالفعل لـ "{action}". إعادة التعيين؟'
  },
  tr: {
    title: 'Kontrolleri yapılandır', shortcutBtn: 'Kısayollar',
    tabKeyboard: 'Klavye', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Oynatma', sectionVolume: 'Ses',
    cartSlot: 'One Shot {n}', pauseResume: 'Duraklat / Devam et', toggleLoop: 'Döngüyü aç/kapat',
    stopAll: 'Tümünü durdur', selectUp: 'Yukarı seç', selectDown: 'Aşağı seç',
    playSelected: 'Seçileni oynat', masterVolume: 'Ana ses',
    midiDevice: 'MIDI Cihazı', allDevices: 'Tüm cihazlar',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Zaten {action} için atanmış',
    pressAnyKey: 'Herhangi bir tuşa basın...', reserved: 'Bu tuş kombinasyonu ayrılmış',
    resetKeyboard: 'Varsayılanlara sıfırla', resetMidi: 'Tümünü sıfırla', close: 'Kapat',
    clear: 'Temizle', learn: 'Öğren', cancel: 'İptal',
    waitingForInput: 'MIDI girişi bekleniyor...', noDevices: 'MIDI cihazı algılanmadı',
    reassign: 'Yeniden ata', conflictMessage: 'Bu MIDI kontrolü zaten "{action}" için atanmış. Yeniden ata?'
  },
  el: {
    title: 'Ρύθμιση ελέγχων', shortcutBtn: 'Συντομεύσεις',
    tabKeyboard: 'Πληκτρολόγιο', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Αναπαραγωγή', sectionVolume: 'Ένταση',
    cartSlot: 'One Shot {n}', pauseResume: 'Παύση / Συνέχεια', toggleLoop: 'Εναλλαγή βρόχου',
    stopAll: 'Διακοπή όλων', selectUp: 'Επιλογή πάνω', selectDown: 'Επιλογή κάτω',
    playSelected: 'Αναπαραγωγή επιλεγμένου', masterVolume: 'Κύρια ένταση',
    midiDevice: 'Συσκευή MIDI', allDevices: 'Όλες οι συσκευές',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Ήδη αντιστοιχισμένο σε {action}',
    pressAnyKey: 'Πατήστε οποιοδήποτε πλήκτρο...', reserved: 'Αυτός ο συνδυασμός πλήκτρων είναι δεσμευμένος',
    resetKeyboard: 'Επαναφορά προεπιλογών', resetMidi: 'Επαναφορά όλων', close: 'Κλείσιμο',
    clear: 'Εκκαθάριση', learn: 'Εκμάθηση', cancel: 'Ακύρωση',
    waitingForInput: 'Αναμονή εισόδου MIDI...', noDevices: 'Δεν ανιχνεύτηκαν συσκευές MIDI',
    reassign: 'Νέα αντιστοίχιση', conflictMessage: 'Αυτός ο ελεγκτής MIDI είναι ήδη αντιστοιχισμένος στο "{action}". Νέα αντιστοίχιση;'
  },
  no: {
    title: 'Konfigurer kontroller', shortcutBtn: 'Snarveier',
    tabKeyboard: 'Tastatur', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Avspilling', sectionVolume: 'Volum',
    cartSlot: 'One Shot {n}', pauseResume: 'Pause / Fortsett', toggleLoop: 'Bytt løkke',
    stopAll: 'Stopp alle', selectUp: 'Velg opp', selectDown: 'Velg ned',
    playSelected: 'Spill av valgt', masterVolume: 'Hovedvolum',
    midiDevice: 'MIDI-enhet', allDevices: 'Alle enheter',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Allerede tilordnet {action}',
    pressAnyKey: 'Trykk på en tast...', reserved: 'Denne tastekombinasjon er reservert',
    resetKeyboard: 'Tilbakestill til standard', resetMidi: 'Tilbakestill alle', close: 'Lukk',
    clear: 'Slett', learn: 'Lær', cancel: 'Avbryt',
    waitingForInput: 'Venter på MIDI-inndata...', noDevices: 'Ingen MIDI-enheter funnet',
    reassign: 'Tilordne på nytt', conflictMessage: 'Denne MIDI-kontrollen er allerede tilordnet "{action}". Tilordne på nytt?'
  },
  sv: {
    title: 'Konfigurera kontroller', shortcutBtn: 'Genvägar',
    tabKeyboard: 'Tangentbord', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Uppspelning', sectionVolume: 'Volym',
    cartSlot: 'One Shot {n}', pauseResume: 'Pausa / Fortsätt', toggleLoop: 'Växla loop',
    stopAll: 'Stoppa alla', selectUp: 'Välj uppåt', selectDown: 'Välj nedåt',
    playSelected: 'Spela valt', masterVolume: 'Mastervolym',
    midiDevice: 'MIDI-enhet', allDevices: 'Alla enheter',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Redan tilldelat {action}',
    pressAnyKey: 'Tryck på valfri tangent...', reserved: 'Denna tangentkombination är reserverad',
    resetKeyboard: 'Återställ till standard', resetMidi: 'Återställ alla', close: 'Stäng',
    clear: 'Rensa', learn: 'Lär in', cancel: 'Avbryt',
    waitingForInput: 'Väntar på MIDI-inmatning...', noDevices: 'Inga MIDI-enheter hittades',
    reassign: 'Tilldela om', conflictMessage: 'Denna MIDI-kontroll är redan tilldelad "{action}". Tilldela om?'
  },
  ro: {
    title: 'Configurare controale', shortcutBtn: 'Comenzi rapide',
    tabKeyboard: 'Tastatură', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Redare', sectionVolume: 'Volum',
    cartSlot: 'One Shot {n}', pauseResume: 'Pauză / Reluare', toggleLoop: 'Comutare buclă',
    stopAll: 'Oprire tot', selectUp: 'Selectare sus', selectDown: 'Selectare jos',
    playSelected: 'Redare selectat', masterVolume: 'Volum principal',
    midiDevice: 'Dispozitiv MIDI', allDevices: 'Toate dispozitivele',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Deja atribuit la {action}',
    pressAnyKey: 'Apăsați orice tastă...', reserved: 'Această combinație de taste este rezervată',
    resetKeyboard: 'Resetare la implicit', resetMidi: 'Resetare totală', close: 'Închide',
    clear: 'Șterge', learn: 'Învățare', cancel: 'Anulare',
    waitingForInput: 'Așteptând intrare MIDI...', noDevices: 'Nu s-au detectat dispozitive MIDI',
    reassign: 'Reatribuire', conflictMessage: 'Acest control MIDI este deja atribuit la "{action}". Reatribuiți?'
  },
  sq: {
    title: 'Konfiguro kontrollet', shortcutBtn: 'Shkurtore',
    tabKeyboard: 'Tastierë', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'Luajtja', sectionVolume: 'Volumi',
    cartSlot: 'One Shot {n}', pauseResume: 'Pauzë / Vazhdo', toggleLoop: 'Ndërro buklën',
    stopAll: 'Ndalo të gjitha', selectUp: 'Zgjidh lart', selectDown: 'Zgjidh poshtë',
    playSelected: 'Luaj të zgjedhurën', masterVolume: 'Volumi kryesor',
    midiDevice: 'Pajisja MIDI', allDevices: 'Të gjitha pajisjet',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'Tashmë e caktuar për {action}',
    pressAnyKey: 'Shtypni çdo çelës...', reserved: 'Ky kombinim çelësash është i rezervuar',
    resetKeyboard: 'Rivendos vlerat e paracaktuara', resetMidi: 'Rivendos të gjitha', close: 'Mbyll',
    clear: 'Pastro', learn: 'Mëso', cancel: 'Anulo',
    waitingForInput: 'Duke pritur hyrjen MIDI...', noDevices: 'Nuk u zbuluan pajisje MIDI',
    reassign: 'Ricakto', conflictMessage: 'Ky kontroll MIDI është tashmë caktuar për "{action}". Ricakto?'
  },
  hi: {
    title: 'नियंत्रण कॉन्फ़िगर करें', shortcutBtn: 'शॉर्टकट',
    tabKeyboard: 'कीबोर्ड', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'प्लेबैक', sectionVolume: 'वॉल्यूम',
    cartSlot: 'One Shot {n}', pauseResume: 'रोकें / जारी रखें', toggleLoop: 'लूप टॉगल करें',
    stopAll: 'सभी रोकें', selectUp: 'ऊपर चुनें', selectDown: 'नीचे चुनें',
    playSelected: 'चयनित चलाएं', masterVolume: 'मास्टर वॉल्यूम',
    midiDevice: 'MIDI डिवाइस', allDevices: 'सभी डिवाइस',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: '{action} को पहले से असाइन किया गया',
    pressAnyKey: 'कोई भी कुंजी दबाएं...', reserved: 'यह कुंजी संयोजन आरक्षित है',
    resetKeyboard: 'डिफ़ॉल्ट पर रीसेट करें', resetMidi: 'सब रीसेट करें', close: 'बंद करें',
    clear: 'साफ़ करें', learn: 'सीखें', cancel: 'रद्द करें',
    waitingForInput: 'MIDI इनपुट की प्रतीक्षा...', noDevices: 'कोई MIDI डिवाइस नहीं मिला',
    reassign: 'पुनः असाइन करें', conflictMessage: 'यह MIDI नियंत्रण पहले से "{action}" को असाइन किया गया है। पुनः असाइन करें?'
  },
  bn: {
    title: 'নিয়ন্ত্রণ কনফিগার করুন', shortcutBtn: 'শর্টকাট',
    tabKeyboard: 'কীবোর্ড', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'প্লেব্যাক', sectionVolume: 'ভলিউম',
    cartSlot: 'One Shot {n}', pauseResume: 'বিরতি / চালু করুন', toggleLoop: 'লুপ টগল করুন',
    stopAll: 'সব বন্ধ করুন', selectUp: 'উপরে নির্বাচন করুন', selectDown: 'নিচে নির্বাচন করুন',
    playSelected: 'নির্বাচিত চালান', masterVolume: 'মাস্টার ভলিউম',
    midiDevice: 'MIDI ডিভাইস', allDevices: 'সব ডিভাইস',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: '{action} এ ইতিমধ্যে নির্ধারিত',
    pressAnyKey: 'যেকোনো কী চাপুন...', reserved: 'এই কী সংমিশ্রণ সংরক্ষিত',
    resetKeyboard: 'ডিফল্টে রিসেট করুন', resetMidi: 'সব রিসেট করুন', close: 'বন্ধ করুন',
    clear: 'পরিষ্কার করুন', learn: 'শিখুন', cancel: 'বাতিল করুন',
    waitingForInput: 'MIDI ইনপুটের জন্য অপেক্ষা...', noDevices: 'কোনো MIDI ডিভাইস পাওয়া যায়নি',
    reassign: 'পুনরায় নির্ধারণ করুন', conflictMessage: 'এই MIDI নিয়ন্ত্রণ ইতিমধ্যে "{action}" এ নির্ধারিত। পুনরায় নির্ধারণ করুন?'
  },
  fa: {
    title: 'پیکربندی کنترل‌ها', shortcutBtn: 'میانبرها',
    tabKeyboard: 'صفحه‌کلید', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'پخش', sectionVolume: 'صدا',
    cartSlot: 'One Shot {n}', pauseResume: 'مکث / ادامه', toggleLoop: 'تغییر حالت حلقه',
    stopAll: 'توقف همه', selectUp: 'انتخاب بالا', selectDown: 'انتخاب پایین',
    playSelected: 'پخش انتخاب‌شده', masterVolume: 'صدای اصلی',
    midiDevice: 'دستگاه MIDI', allDevices: 'همه دستگاه‌ها',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'قبلاً به {action} اختصاص داده شده',
    pressAnyKey: 'هر کلیدی را فشار دهید...', reserved: 'این ترکیب کلید رزرو شده است',
    resetKeyboard: 'بازنشانی به پیش‌فرض', resetMidi: 'بازنشانی همه', close: 'بستن',
    clear: 'پاک کردن', learn: 'آموزش', cancel: 'لغو',
    waitingForInput: 'در انتظار ورودی MIDI...', noDevices: 'هیچ دستگاه MIDI شناسایی نشد',
    reassign: 'تخصیص مجدد', conflictMessage: 'این کنترل MIDI قبلاً به "{action}" اختصاص داده شده است. تخصیص مجدد؟'
  },
  ur: {
    title: 'کنٹرولز ترتیب دیں', shortcutBtn: 'شارٹ کٹس',
    tabKeyboard: 'کی بورڈ', tabMidi: 'MIDI',
    sectionCartSlots: 'One Shots', sectionPlayback: 'پلے بیک', sectionVolume: 'آواز',
    cartSlot: 'One Shot {n}', pauseResume: 'روکیں / جاری رکھیں', toggleLoop: 'لوپ ٹوگل کریں',
    stopAll: 'سب بند کریں', selectUp: 'اوپر منتخب کریں', selectDown: 'نیچے منتخب کریں',
    playSelected: 'منتخب کو چلائیں', masterVolume: 'ماسٹر آواز',
    midiDevice: 'MIDI آلہ', allDevices: 'تمام آلات',
    conflictSlot: 'Already assigned to One Shot {n}', conflictAction: 'پہلے سے {action} کو تفویض',
    pressAnyKey: 'کوئی بھی کلید دبائیں...', reserved: 'یہ کلید کا مجموعہ محفوظ ہے',
    resetKeyboard: 'پہلے سے طے شدہ پر ری سیٹ کریں', resetMidi: 'سب ری سیٹ کریں', close: 'بند کریں',
    clear: 'صاف کریں', learn: 'سیکھیں', cancel: 'منسوخ کریں',
    waitingForInput: 'MIDI ان پٹ کا انتظار...', noDevices: 'کوئی MIDI آلہ نہیں ملا',
    reassign: 'دوبارہ تفویض کریں', conflictMessage: 'یہ MIDI کنٹرول پہلے سے "{action}" کو تفویض ہے۔ دوبارہ تفویض کریں؟'
  }
};

const localesDir = './locales';
const files = readdirSync(localesDir).filter(f => f.endsWith('.json'));
let updated = 0;

for (const file of files) {
  const code = file.replace('.json', '');
  const filePath = join(localesDir, file);
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const t = TRANSLATIONS[code] || TRANSLATIONS['en'];

  // Merge so running this maintenance script cannot erase newer controls
  // added to the locale files. One Shots are the product term; the old cart
  // keys remain only as storage/IPC compatibility aliases.
  data.controls = { ...(data.controls || {}), ...t };
  data.controls.sectionOneShots = t.sectionOneShots || 'One Shots';
  data.controls.oneShot = t.oneShot || 'One Shot {n}';
  data.controls.conflictOneShot = t.conflictOneShot || 'Already assigned to One Shot {n}';
  data.controls.sectionCartSlots = data.controls.sectionOneShots;
  data.controls.cartSlot = data.controls.oneShot;
  data.controls.conflictSlot = data.controls.conflictOneShot;

  // Old detached-window code can still read this namespace while an existing
  // project is migrating. Keep those aliases truthful so a locale refresh
  // never brings retired quick-play wording back into the UI.
  if (data.cart) {
    data.cart.title = 'One Shots';
    data.cart.slot = 'One Shot';
    data.cart.conflict = 'Already assigned to One Shot {slot}';
    if ('show' in data.cart) data.cart.show = 'Show One Shots';
    if ('hide' in data.cart) data.cart.hide = 'Hide One Shots';
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const tag = TRANSLATIONS[code] ? 'native' : 'en-fallback';
  console.log(`Updated: ${file} (${tag})`);
  updated++;
}
console.log(`\nDone. Updated ${updated} files.`);
