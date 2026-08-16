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
window.KAKEIBO_ASSET_CATEGORIES = ['預金', '定期預金', '証券', '保険', '不動産', 'その他'];
window.KAKEIBO_LIABILITY_CATEGORIES = ['住宅ローン', '自動車ローン', 'その他負債'];

// LINEのトーク上で使えるコマンド一覧（唯一の情報源）。home.html・shopping-list.htmlの
// 「使い方」表示はここから生成する。実際のLINE応答文（supabase/functions/line-webhook/index.ts
// のLINE_HELP_TEXT）はDeno側の別ファイルのため自動同期はできない。コマンドを追加・変更する際は
// 両方を手動でセットで更新すること
window.KAKEIBO_LINE_COMMANDS = [
  { cmd: '追加 アイテム名', desc: '買い物リストに追加', example: '追加 牛乳' },
  { cmd: '完了 アイテム名', desc: 'そのアイテムを買い物リストで完了にする', example: '完了 牛乳' },
  { cmd: '修正 ...', desc: '直近の家計簿記録を修正する', example: '修正 金額を1200円に' },
  { cmd: '質問 ...', desc: '支出・予算について質問する', example: '質問 今月食費いくら？' },
  { cmd: 'ヘルプ／使い方', desc: 'この説明をLINEのトーク上に表示', example: null }
];
window.buildLineHelpText = function () {
  const lines = ['📖 LINEでできること', ''];
  window.KAKEIBO_LINE_COMMANDS.forEach((c) => {
    lines.push('・「' + c.cmd + '」→ ' + c.desc);
    if (c.example) lines.push('　（例：' + c.example + '）');
  });
  return lines.join('\n');
};
