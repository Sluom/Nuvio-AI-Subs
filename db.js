// db.js (نسخة التخطي المؤقت - Bypass للفحص)

async function init() {
  console.log('[MongoDB - BYPASS] تم إيقاف الاتصال بقاعدة البيانات مؤقتاً لأغراض الفحص. العمل يتم بالذاكرة والمعالجة اللحظية فقط.');
  return false;
}

async function loadDoc(ns, key) {
  // الكود راح يعتبر الفلم ما موجود بالكاش نهائياً
  return null;
}

async function saveDoc(ns, key, value) {
  // تخطي الحفظ
  return true;
}

async function loadMap(ns, key) {
  // يرجع خريطة أسطر فارغة حتى يعيد تصحيحها من الصفر
  return new Map();
}

async function saveMap(ns, key, entries) {
  // تخطي الحفظ
  return true;
}

module.exports = { init, loadDoc, saveDoc, loadMap, saveMap };
