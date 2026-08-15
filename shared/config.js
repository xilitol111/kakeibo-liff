// kakeibo 共通設定（gas/Config.gs相当）。カテゴリ変更時はSupabaseのCHECK制約とセットで更新すること
window.KAKEIBO_CATEGORY_MAP = {
  '食＋消耗品': ['外食', '自炊', '日用品'],
  'ペット': ['猫', 'レオパ', '魚'],
  '旅行＋交際': ['旅行', '交際費'],
  '住居（火災保険含む）': ['家賃', '共益費・駐車場', '火災保険'],
  '車': ['ガソリン', '整備', '自動車保険'],
  '光熱水＋通信': ['電気', 'ガス', '水道', '通信'],
  'サブスク': [],
  'その他': [],
  '未分類': []
};
window.KAKEIBO_FAMILY_MEMBERS = ['一', '成美'];
window.KAKEIBO_SHOPPING_CATEGORIES = ['食品', '日用品', 'ペット用品', 'その他'];
window.KAKEIBO_ASSET_CATEGORIES = ['預金', '証券', '保険', '不動産', 'その他'];
