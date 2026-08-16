// kakeibo 共通データアクセス+業務ロジックモジュール（GASの各 *Client.gs 相当）
// window.kakeiboSupabase（shared/auth.js）を前提に、クライアント側で直接Supabaseへ
// アクセスする。認可はRLS（line_usersに登録済みのユーザーのみ）が担うため、
// GAS時代のrequireAccess_(code)呼び出しは不要になっている。
// 各画面は auth.js の後にこのファイルを読み込むこと。

(function () {
  const sb = () => window.kakeiboSupabase;

  function fmt(date, pattern) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
    if (pattern === 'yyyy-MM-01') return `${parts.year}-${parts.month}-01`;
    if (pattern === 'yyyy-MM') return `${parts.year}-${parts.month}`;
    if (pattern === 'yyyy') return parts.year;
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function todayStr() { return fmt(new Date(), 'yyyy-MM-dd'); }

  function unwrap(res) {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }

  // ---- 低レベルクエリヘルパー（gas/SupabaseClient.gs相当） ----

  async function fetchTransactionsForYear(year) {
    const rows = unwrap(await sb().from('transactions')
      .select('*,recurring_expenses(recurring_expense_groups(name))')
      .gte('occurred_at', `${year}-01-01`).lt('occurred_at', `${Number(year) + 1}-01-01`)
      .order('occurred_at', { ascending: false }));
    rows.forEach((row) => {
      row.recurring_group_name = (row.recurring_expenses && row.recurring_expenses.recurring_expense_groups)
        ? row.recurring_expenses.recurring_expense_groups.name : null;
      delete row.recurring_expenses;
    });
    return rows;
  }

  async function fetchAllTransactions() {
    const rows = unwrap(await sb().from('transactions')
      .select('*,recurring_expenses(recurring_expense_groups(name))')
      .order('occurred_at', { ascending: false }));
    rows.forEach((row) => {
      row.recurring_group_name = (row.recurring_expenses && row.recurring_expenses.recurring_expense_groups)
        ? row.recurring_expenses.recurring_expense_groups.name : null;
      delete row.recurring_expenses;
    });
    return rows;
  }

  async function fetchRecentTransactions(limit) {
    return unwrap(await sb().from('transactions').select('*').order('created_at', { ascending: false }).limit(limit));
  }

  async function insertTransaction(record) {
    return unwrap(await sb().from('transactions').insert(record).select())[0];
  }

  async function updateTransaction(id, patch) {
    return unwrap(await sb().from('transactions').update(patch).eq('id', id).select())[0];
  }

  async function deleteTransaction(id) {
    unwrap(await sb().from('transactions').delete().eq('id', id));
  }

  async function deleteTransactionsByIds(ids) {
    if (!ids || ids.length === 0) return;
    unwrap(await sb().from('transactions').delete().in('id', ids));
  }

  async function insertTransactionsBulk(records) {
    if (!records || records.length === 0) return [];
    return unwrap(await sb().from('transactions').insert(records).select());
  }

  function buildDuplicateFilter_(q, amount, occurredAt, excludeChannel) {
    const date = new Date(occurredAt + 'T00:00:00');
    const from = new Date(date); from.setDate(from.getDate() - 1);
    const to = new Date(date); to.setDate(to.getDate() + 1);
    return q.eq('amount', amount)
      .gte('occurred_at', fmt(from, 'yyyy-MM-dd')).lte('occurred_at', fmt(to, 'yyyy-MM-dd'))
      .neq('source_channel', excludeChannel);
  }

  async function findPossibleDuplicate(amount, occurredAt, excludeChannel) {
    const rows = unwrap(await buildDuplicateFilter_(sb().from('transactions').select('*'), amount, occurredAt, excludeChannel));
    return rows.length > 0 ? rows[0] : null;
  }

  async function insertTransactionWithDuplicateCheck_(record, excludeChannel) {
    const [insertRes, dupRes] = await Promise.all([
      sb().from('transactions').insert(record).select(),
      buildDuplicateFilter_(sb().from('transactions').select('*'), record.amount, record.occurred_at, excludeChannel)
    ]);
    const inserted = unwrap(insertRes)[0];
    const dupRows = unwrap(dupRes);
    return { inserted: inserted, duplicate: dupRows.length > 0 ? dupRows[0] : null };
  }

  async function fetchTransactionsByRecurringExpenseAll(recurringExpenseId) {
    return unwrap(await sb().from('transactions').select('*').eq('recurring_expense_id', recurringExpenseId));
  }

  async function fetchSettlementSummaryRow(yearMonth) {
    const rows = unwrap(await sb().from('settlement_summary').select('*').eq('year_month', yearMonth));
    return rows.length > 0 ? rows[0] : null;
  }

  async function fetchSettlementRatioForMonth(yearMonth) {
    const rows = unwrap(await sb().from('settlement_ratios').select('*').lte('effective_from', yearMonth).order('effective_from', { ascending: false }).limit(1));
    return rows.length > 0 ? rows[0] : null;
  }

  async function fetchAllSettlementRatios() {
    return unwrap(await sb().from('settlement_ratios').select('*').order('effective_from', { ascending: true }));
  }

  async function insertSettlementRatio(record) {
    const res = await sb().from('settlement_ratios').insert(record).select();
    if (res.error) throw new Error('その基準日は既に比率を変更済みです。');
    return res.data[0];
  }

  async function fetchBudgets(yearMonth) {
    return unwrap(await sb().from('budgets').select('*').eq('year_month', yearMonth));
  }

  async function upsertBudget(record) {
    return unwrap(await sb().from('budgets').upsert(record, { onConflict: 'category,year_month' }).select())[0];
  }

  async function fetchAllActiveRecurringExpenses() {
    return unwrap(await sb().from('recurring_expenses').select('*').eq('active', true));
  }

  async function fetchAllRecurringExpenses() {
    return unwrap(await sb().from('recurring_expenses').select('*').order('active', { ascending: false }).order('day_of_month', { ascending: true }));
  }

  async function fetchRecurringExpenseById(id) {
    const rows = unwrap(await sb().from('recurring_expenses').select('*').eq('id', id));
    return rows.length > 0 ? rows[0] : null;
  }

  async function fetchRecurringExpensesByGroup(groupId) {
    return unwrap(await sb().from('recurring_expenses').select('*').eq('group_id', groupId));
  }

  async function insertRecurringExpense(record) {
    return unwrap(await sb().from('recurring_expenses').insert(record).select())[0];
  }
  async function updateRecurringExpense(id, patch) {
    return unwrap(await sb().from('recurring_expenses').update(patch).eq('id', id).select())[0];
  }
  async function deleteRecurringExpense(id) {
    const res = await sb().from('recurring_expenses').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message);
  }

  async function fetchAllRecurringExpenseGroups() {
    return unwrap(await sb().from('recurring_expense_groups').select('*').order('active', { ascending: false }).order('name', { ascending: true }));
  }
  async function fetchRecurringExpenseGroupById(id) {
    const rows = unwrap(await sb().from('recurring_expense_groups').select('*').eq('id', id));
    return rows.length > 0 ? rows[0] : null;
  }
  async function insertRecurringExpenseGroup(record) {
    return unwrap(await sb().from('recurring_expense_groups').insert(record).select())[0];
  }
  async function updateRecurringExpenseGroup(id, patch) {
    return unwrap(await sb().from('recurring_expense_groups').update(patch).eq('id', id).select())[0];
  }
  async function deleteRecurringExpenseGroup(id) {
    const res = await sb().from('recurring_expense_groups').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message);
  }

  async function fetchSettlementConfirmation(yearMonth) {
    const rows = unwrap(await sb().from('settlement_confirmations').select('*').eq('year_month', yearMonth));
    return rows.length > 0 ? rows[0] : null;
  }
  async function fetchSettlementConfirmationsForYear(year) {
    return unwrap(await sb().from('settlement_confirmations').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`));
  }
  async function upsertSettlementConfirmation(record) {
    return unwrap(await sb().from('settlement_confirmations').upsert(record, { onConflict: 'year_month' }).select())[0];
  }
  async function deleteSettlementConfirmation(yearMonth) {
    const res = await sb().from('settlement_confirmations').delete().eq('year_month', yearMonth);
    if (res.error) throw new Error(res.error.message);
  }
  async function fetchAllConfirmedMonthKeys() {
    const rows = unwrap(await sb().from('settlement_confirmations').select('year_month'));
    const keys = {};
    rows.forEach((r) => { keys[String(r.year_month).slice(0, 7)] = true; });
    return keys;
  }

  async function fetchAllEvents() {
    return unwrap(await sb().from('events').select('*').order('created_at', { ascending: false }));
  }
  async function fetchEventActuals() {
    return unwrap(await sb().from('transactions').select('event_tag,amount').not('event_tag', 'is', null));
  }
  async function insertEvent(record) {
    const res = await sb().from('events').insert(record).select();
    if (res.error) {
      if (res.error.message.indexOf('events_name_key') !== -1 || res.error.message.indexOf('duplicate key') !== -1) {
        throw new Error('同じ名前のイベントが既に存在します。');
      }
      throw new Error(res.error.message);
    }
    return res.data[0];
  }
  async function updateEvent(id, patch) {
    const res = await sb().from('events').update(patch).eq('id', id).select();
    if (res.error) {
      if (res.error.message.indexOf('events_name_key') !== -1 || res.error.message.indexOf('duplicate key') !== -1) {
        throw new Error('同じ名前のイベントが既に存在します。');
      }
      throw new Error(res.error.message);
    }
    return res.data[0];
  }
  async function deleteEvent(id) {
    const res = await sb().from('events').delete().eq('id', id);
    if (res.error) {
      if (res.error.message.indexOf('foreign key') !== -1) {
        throw new Error('このイベントが付いた取引がまだあるため削除できません。先に該当取引のイベントタグを外してください。');
      }
      throw new Error(res.error.message);
    }
  }

  async function fetchUnclassifiedTransactions() {
    return unwrap(await sb().from('transactions').select('id,occurred_at,name,amount,source_channel').eq('category', '未分類').order('occurred_at', { ascending: true }));
  }
  async function fetchEventReviewQueue() {
    return unwrap(await sb().from('event_tag_review_queue')
      .select('id,transaction_id,suggested_event_name,reason,created_at,transactions(name,amount,occurred_at,category,subcategory)')
      .order('created_at', { ascending: true }));
  }
  async function fetchAutoImportsSince(sinceTimestamp) {
    return unwrap(await sb().from('transactions')
      .select('id,occurred_at,name,amount,category,subcategory,source_channel,created_at')
      .in('source_channel', ['gmail_auto', 'recurring_auto'])
      .gt('created_at', sinceTimestamp)
      .order('created_at', { ascending: false }));
  }
  async function fetchMonthlyCategorySummaryRows(yearMonth) {
    return unwrap(await sb().from('monthly_category_summary').select('*').eq('year_month', yearMonth));
  }
  async function fetchMonthlyCategorySummaryRange(fromYm, toYm) {
    return unwrap(await sb().from('monthly_category_summary').select('*').gte('year_month', fromYm).lte('year_month', toYm));
  }
  async function fetchBudgetVsActualRange(fromYm, toYm) {
    return unwrap(await sb().from('budget_vs_actual').select('*').gte('year_month', fromYm).lte('year_month', toYm));
  }

  async function fetchUnpurchasedShoppingItems() {
    return unwrap(await sb().from('shopping_items').select('*').is('purchased_at', null).order('created_at', { ascending: true }));
  }
  async function fetchPurchasedShoppingItems(limit) {
    return unwrap(await sb().from('shopping_items').select('*').not('purchased_at', 'is', null).order('purchased_at', { ascending: false }).limit(limit));
  }
  async function insertShoppingItem(record) {
    return unwrap(await sb().from('shopping_items').insert(record).select())[0];
  }
  async function updateShoppingItem(id, patch) {
    return unwrap(await sb().from('shopping_items').update(patch).eq('id', id).select())[0];
  }
  async function deleteShoppingItem(id) {
    const res = await sb().from('shopping_items').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message);
  }

  // ---- 資産管理 ----
  // asset_items: 資産項目のプリセット（誰・種別・保管会社）。asset_snapshots: 時点ごとの金額
  async function fetchAssetItems(activeOnly) {
    let q = sb().from('asset_items').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
    if (activeOnly) q = q.eq('active', true);
    return unwrap(await q);
  }
  async function insertAssetItem(record) {
    return unwrap(await sb().from('asset_items').insert(record).select())[0];
  }
  async function updateAssetItem(id, patch) {
    return unwrap(await sb().from('asset_items').update(patch).eq('id', id).select())[0];
  }
  async function deactivateAssetItem(id) {
    return updateAssetItem(id, { active: false });
  }
  async function fetchAllAssetSnapshots() {
    return unwrap(await sb().from('asset_snapshots')
      .select('*,asset_items(person,category,institution,active,item_type)')
      .order('as_of_date', { ascending: true }));
  }
  async function upsertAssetSnapshotBatch(asOfDate, entries) {
    if (!entries || entries.length === 0) return [];
    const records = entries.map((e) => ({ asset_item_id: e.assetItemId, as_of_date: asOfDate, amount: e.amount }));
    return unwrap(await sb().from('asset_snapshots').upsert(records, { onConflict: 'asset_item_id,as_of_date' }).select());
  }

  // ---- 純粋な計算ロジック（gas/SettlementClient.gs等と同一） ----

  function calculateSettlement(totalSharedAmount, paidKazuichi, paidNarumi, ratioKazuichi, ratioNarumi, owedByKazuichi, owedByNarumi) {
    owedByKazuichi = owedByKazuichi || 0;
    owedByNarumi = owedByNarumi || 0;
    if (ratioKazuichi === null || ratioKazuichi === undefined) ratioKazuichi = 0.5;
    if (ratioNarumi === null || ratioNarumi === undefined) ratioNarumi = 0.5;
    const sharedFairShareKazuichi = Math.round(totalSharedAmount * ratioKazuichi);
    const sharedFairShareNarumi = totalSharedAmount - sharedFairShareKazuichi;
    const fairShareKazuichi = sharedFairShareKazuichi + owedByKazuichi;
    const fairShareNarumi = sharedFairShareNarumi + owedByNarumi;
    const diffKazuichi = paidKazuichi - fairShareKazuichi;
    return {
      fairShareKazuichi, fairShareNarumi, diffKazuichi,
      transferFrom: diffKazuichi >= 0 ? '成美' : '一',
      transferTo: diffKazuichi >= 0 ? '一' : '成美',
      transferAmount: Math.abs(diffKazuichi)
    };
  }

  function calculateSettlementVariant_(row, suffix) {
    if (!row) return calculateSettlement(0, 0, 0, 0.5, 0.5, 0, 0);
    const f = (base) => row[base + suffix] || 0;
    return calculateSettlement(
      f('total_shared_amount'), f('paid_kazuichi'), f('paid_narumi'),
      row.ratio_kazuichi, row.ratio_narumi, f('owed_by_kazuichi'), f('owed_by_narumi')
    );
  }
  function buildTransferSummary_(row, suffix) {
    const r = calculateSettlementVariant_(row, suffix);
    return { transferFrom: r.transferAmount > 0 ? r.transferFrom : null, transferTo: r.transferAmount > 0 ? r.transferTo : null, transferAmount: r.transferAmount };
  }
  function attachComparisonVariants_(summary, row) {
    summary.gross = buildTransferSummary_(row, '_gross');
    summary.exclEvent = buildTransferSummary_(row, '_excl_event');
    summary.grossExclEvent = buildTransferSummary_(row, '_gross_excl_event');
    return summary;
  }

  function buildConfirmedSettlementSummary_(yearMonth, confirmation) {
    return {
      yearMonth, totalSharedAmount: confirmation.total_shared_amount,
      paidKazuichi: confirmation.paid_kazuichi, paidNarumi: confirmation.paid_narumi,
      owedByKazuichi: confirmation.owed_by_kazuichi, owedByNarumi: confirmation.owed_by_narumi,
      ratioKazuichi: confirmation.ratio_kazuichi, ratioNarumi: confirmation.ratio_narumi,
      fairShareKazuichi: confirmation.fair_share_kazuichi, fairShareNarumi: confirmation.fair_share_narumi,
      diffKazuichi: confirmation.diff_kazuichi,
      transferFrom: confirmation.transfer_amount > 0 ? confirmation.transfer_from : null,
      transferTo: confirmation.transfer_amount > 0 ? confirmation.transfer_to : null,
      transferAmount: confirmation.transfer_amount,
      confirmed: true, confirmedAt: confirmation.confirmed_at
    };
  }

  async function buildSettlementSummary_(yearMonth, row) {
    const ratioRow = row || await fetchSettlementRatioForMonth(yearMonth);
    const ratioKazuichi = (ratioRow && ratioRow.ratio_kazuichi != null) ? ratioRow.ratio_kazuichi : 0.5;
    const ratioNarumi = (ratioRow && ratioRow.ratio_narumi != null) ? ratioRow.ratio_narumi : 0.5;
    const totalSharedAmount = row ? row.total_shared_amount : 0;
    const paidKazuichi = (row && row.paid_kazuichi) || 0;
    const paidNarumi = (row && row.paid_narumi) || 0;
    const owedByKazuichi = (row && row.owed_by_kazuichi) || 0;
    const owedByNarumi = (row && row.owed_by_narumi) || 0;
    const result = calculateSettlement(totalSharedAmount, paidKazuichi, paidNarumi, ratioKazuichi, ratioNarumi, owedByKazuichi, owedByNarumi);
    return Object.assign({ yearMonth, totalSharedAmount, paidKazuichi, paidNarumi, owedByKazuichi, owedByNarumi, ratioKazuichi, ratioNarumi, confirmed: false }, result);
  }

  async function getSettlementSummary(yearMonth) {
    const [confirmation, row] = await Promise.all([fetchSettlementConfirmation(yearMonth), fetchSettlementSummaryRow(yearMonth)]);
    const summary = confirmation ? buildConfirmedSettlementSummary_(yearMonth, confirmation) : await buildSettlementSummary_(yearMonth, row);
    return attachComparisonVariants_(summary, row);
  }

  async function confirmSettlementMonth(yearMonth) {
    const row = await fetchSettlementSummaryRow(yearMonth);
    const summary = await buildSettlementSummary_(yearMonth, row);
    await upsertSettlementConfirmation({
      year_month: yearMonth, total_shared_amount: summary.totalSharedAmount,
      paid_kazuichi: summary.paidKazuichi, paid_narumi: summary.paidNarumi,
      owed_by_kazuichi: summary.owedByKazuichi, owed_by_narumi: summary.owedByNarumi,
      ratio_kazuichi: summary.ratioKazuichi, ratio_narumi: summary.ratioNarumi,
      fair_share_kazuichi: summary.fairShareKazuichi, fair_share_narumi: summary.fairShareNarumi,
      diff_kazuichi: summary.diffKazuichi, transfer_from: summary.transferFrom,
      transfer_to: summary.transferTo, transfer_amount: summary.transferAmount
    });
    return getSettlementSummary(yearMonth);
  }
  async function unconfirmSettlementMonth(yearMonth) {
    await deleteSettlementConfirmation(yearMonth);
    return getSettlementSummary(yearMonth);
  }

  function buildYearlySettlementSummary_(year, rows, ratioRows, confirmationRows) {
    const rowByMonth = {}; rows.forEach((row) => { rowByMonth[row.year_month] = row; });
    const confirmationByMonth = {}; confirmationRows.forEach((c) => { confirmationByMonth[c.year_month] = c; });
    let totalSharedAmount = 0, paidKazuichi = 0, paidNarumi = 0, netDiffKazuichi = 0;
    let grossDiffKazuichi = 0, exclEventDiffKazuichi = 0, grossExclEventDiffKazuichi = 0;
    Object.keys(rowByMonth).forEach((yearMonth) => {
      const row = rowByMonth[yearMonth];
      grossDiffKazuichi += calculateSettlementVariant_(row, '_gross').diffKazuichi;
      exclEventDiffKazuichi += calculateSettlementVariant_(row, '_excl_event').diffKazuichi;
      grossExclEventDiffKazuichi += calculateSettlementVariant_(row, '_gross_excl_event').diffKazuichi;
    });
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const yearMonth = `${year}-${String(m).padStart(2, '0')}-01`;
      const confirmation = confirmationByMonth[yearMonth];
      if (confirmation) {
        totalSharedAmount += confirmation.total_shared_amount;
        paidKazuichi += confirmation.paid_kazuichi;
        paidNarumi += confirmation.paid_narumi;
        netDiffKazuichi += confirmation.diff_kazuichi;
        months.push({ yearMonth, totalSharedAmount: confirmation.total_shared_amount, paidKazuichi: confirmation.paid_kazuichi, paidNarumi: confirmation.paid_narumi, owedByKazuichi: confirmation.owed_by_kazuichi, owedByNarumi: confirmation.owed_by_narumi, transferFrom: confirmation.transfer_amount > 0 ? confirmation.transfer_from : null, transferTo: confirmation.transfer_amount > 0 ? confirmation.transfer_to : null, transferAmount: confirmation.transfer_amount, confirmed: true });
        continue;
      }
      const row = rowByMonth[yearMonth];
      if (!row) {
        months.push({ yearMonth, totalSharedAmount: 0, paidKazuichi: 0, paidNarumi: 0, owedByKazuichi: 0, owedByNarumi: 0, transferFrom: null, transferTo: null, transferAmount: 0, confirmed: false });
        continue;
      }
      const result = calculateSettlement(row.total_shared_amount, row.paid_kazuichi || 0, row.paid_narumi || 0, row.ratio_kazuichi, row.ratio_narumi, row.owed_by_kazuichi || 0, row.owed_by_narumi || 0);
      totalSharedAmount += row.total_shared_amount; paidKazuichi += row.paid_kazuichi || 0; paidNarumi += row.paid_narumi || 0; netDiffKazuichi += result.diffKazuichi;
      months.push({ yearMonth, totalSharedAmount: row.total_shared_amount, paidKazuichi: row.paid_kazuichi || 0, paidNarumi: row.paid_narumi || 0, owedByKazuichi: row.owed_by_kazuichi || 0, owedByNarumi: row.owed_by_narumi || 0, transferFrom: result.transferAmount > 0 ? result.transferFrom : null, transferTo: result.transferAmount > 0 ? result.transferTo : null, transferAmount: result.transferAmount, confirmed: false });
    }
    const ratioAtYearStart = ratioRows.length > 0 ? ratioRows[0] : null;
    const diffToTransfer = (diff) => ({ transferFrom: diff >= 0 ? '成美' : '一', transferTo: diff >= 0 ? '一' : '成美', transferAmount: Math.round(Math.abs(diff)) });
    const net = diffToTransfer(netDiffKazuichi);
    return {
      year, totalSharedAmount, paidKazuichi, paidNarumi,
      netTransferFrom: net.transferFrom, netTransferTo: net.transferTo, netTransferAmount: net.transferAmount,
      gross: diffToTransfer(grossDiffKazuichi), exclEvent: diffToTransfer(exclEventDiffKazuichi), grossExclEvent: diffToTransfer(grossExclEventDiffKazuichi),
      ratioKazuichiAtYearStart: ratioAtYearStart ? ratioAtYearStart.ratio_kazuichi : 0.5,
      months
    };
  }

  async function getYearlySettlementSummary(year) {
    const [rows, ratioRows, confirmationRows] = await Promise.all([
      sb().from('settlement_summary').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      sb().from('settlement_ratios').select('*').lte('effective_from', `${year}-01-01`).order('effective_from', { ascending: false }).limit(1).then(unwrap),
      fetchSettlementConfirmationsForYear(year)
    ]);
    return buildYearlySettlementSummary_(year, rows, ratioRows, confirmationRows);
  }

  function buildSettlementRatioPeriods_(rows) {
    const today = todayStr();
    return rows.map((row, i) => {
      const next = rows[i + 1];
      let endDate = null;
      if (next) {
        const d = new Date(next.effective_from + 'T00:00:00');
        d.setDate(d.getDate() - 1);
        endDate = fmt(d, 'yyyy-MM-dd');
      }
      return {
        startDate: row.effective_from, endDate,
        ratioKazuichi: Number(row.ratio_kazuichi), ratioNarumi: Number(row.ratio_narumi),
        isFuture: row.effective_from > today,
        isCurrent: endDate === null || (row.effective_from <= today && endDate >= today)
      };
    });
  }
  async function getSettlementRatioPeriods() {
    return buildSettlementRatioPeriods_(await fetchAllSettlementRatios());
  }

  async function saveRatioChange_(effectiveFrom, newRatioKazuichi) {
    return insertSettlementRatio({ effective_from: effectiveFrom, ratio_kazuichi: newRatioKazuichi, ratio_narumi: Number((1 - newRatioKazuichi).toFixed(3)) });
  }
  async function saveNewYearRatio(year, newRatioKazuichi) { return saveRatioChange_(`${year}-01-01`, newRatioKazuichi); }
  async function saveNewRatio(newRatioKazuichi) { return saveRatioChange_(fmt(new Date(), 'yyyy-MM-01'), newRatioKazuichi); }

  async function getSettlementScreenInitialData(year) {
    const [rows, ratioRows, confirmationRows, allRatioRows] = await Promise.all([
      sb().from('settlement_summary').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      sb().from('settlement_ratios').select('*').lte('effective_from', `${year}-01-01`).order('effective_from', { ascending: false }).limit(1).then(unwrap),
      fetchSettlementConfirmationsForYear(year),
      fetchAllSettlementRatios()
    ]);
    return { yearlyData: buildYearlySettlementSummary_(year, rows, ratioRows, confirmationRows), ratioPeriods: buildSettlementRatioPeriods_(allRatioRows) };
  }

  // ---- 予算（gas/BudgetClient.gs） ----

  function nextYearMonth_(yearMonth) {
    const d = new Date(yearMonth + 'T00:00:00');
    d.setMonth(d.getMonth() + 1);
    return fmt(d, 'yyyy-MM-dd');
  }

  async function fetchDedicatedEventNames_() {
    const rows = unwrap(await sb().from('events').select('name').eq('budget_scope', 'dedicated'));
    return new Set(rows.map((r) => r.name));
  }

  async function getBudgetsForMonth(yearMonth) {
    const [budgetRows, allRows, ratioRows, dedicatedNames] = await Promise.all([
      fetchBudgets(yearMonth),
      sb().from('transactions').select('category,amount,is_reimbursement,event_tag').gte('occurred_at', yearMonth).lt('occurred_at', nextYearMonth_(yearMonth)).then(unwrap),
      sb().from('settlement_ratios').select('*').lte('effective_from', yearMonth).order('effective_from', { ascending: false }).limit(1).then(unwrap),
      fetchDedicatedEventNames_()
    ]);
    // カテゴリ予算の実績は「日常系（event_tagなし）」＋「小規模イベント（category scope）」を含む。
    // 大規模イベント（dedicated scope）だけを除外する
    const actualRows = allRows.filter((row) => !row.event_tag || !dedicatedNames.has(row.event_tag));
    const budgetMap = {}; budgetRows.forEach((row) => { budgetMap[row.category] = row.budget_amount; });
    const actualMap = {}, actualGrossMap = {};
    actualRows.forEach((row) => {
      actualMap[row.category] = (actualMap[row.category] || 0) + row.amount;
      if (!row.is_reimbursement) actualGrossMap[row.category] = (actualGrossMap[row.category] || 0) + row.amount;
    });
    const categories = {}; let budgetTotal = 0;
    Object.keys(window.KAKEIBO_CATEGORY_MAP).forEach((cat) => {
      const budget = budgetMap[cat] !== undefined ? budgetMap[cat] : null;
      const actual = actualMap[cat] || 0;
      const actualGross = actualGrossMap[cat] || 0;
      if (budget !== null) budgetTotal += budget;
      categories[cat] = { budget, actual, actualGross, pct: (budget !== null && budget > 0) ? Math.round((actual / budget) * 100) : null, pctGross: (budget !== null && budget > 0) ? Math.round((actualGross / budget) * 100) : null };
    });
    const ratio = ratioRows.length > 0 ? ratioRows[0] : null;
    const ratioKazuichi = ratio ? ratio.ratio_kazuichi : 0.5;
    const ratioNarumi = ratio ? ratio.ratio_narumi : 0.5;
    return { categories, budgetTotal, ratioKazuichi, ratioNarumi, projectedKazuichi: Math.round(budgetTotal * ratioKazuichi), projectedNarumi: Math.round(budgetTotal * ratioNarumi) };
  }

  function buildYearlyBudgetSummary_(year, categoryRows, budgetRows, ratioRows) {
    const actualByMonth = {}, actualGrossByMonth = {}, actualByCategory = {}, actualGrossByCategory = {};
    categoryRows.forEach((row) => {
      const monthKey = row.occurred_at.slice(0, 7) + '-01';
      actualByMonth[monthKey] = (actualByMonth[monthKey] || 0) + row.amount;
      actualByCategory[row.category] = (actualByCategory[row.category] || 0) + row.amount;
      if (!row.is_reimbursement) {
        actualGrossByMonth[monthKey] = (actualGrossByMonth[monthKey] || 0) + row.amount;
        actualGrossByCategory[row.category] = (actualGrossByCategory[row.category] || 0) + row.amount;
      }
    });
    const budgetByMonth = {}, budgetByCategory = {};
    budgetRows.forEach((row) => {
      budgetByMonth[row.year_month] = (budgetByMonth[row.year_month] || 0) + row.budget_amount;
      budgetByCategory[row.category] = (budgetByCategory[row.category] || 0) + row.budget_amount;
    });
    let yearBudgetTotal = 0, yearActualTotal = 0, yearActualGrossTotal = 0;
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const yearMonth = `${year}-${String(m).padStart(2, '0')}-01`;
      const budgetTotal = budgetByMonth[yearMonth] || 0, actualTotal = actualByMonth[yearMonth] || 0, actualGrossTotal = actualGrossByMonth[yearMonth] || 0;
      yearBudgetTotal += budgetTotal; yearActualTotal += actualTotal; yearActualGrossTotal += actualGrossTotal;
      months.push({ yearMonth, budgetTotal, actualTotal, actualGrossTotal, pct: budgetTotal > 0 ? Math.round((actualTotal / budgetTotal) * 100) : null, pctGross: budgetTotal > 0 ? Math.round((actualGrossTotal / budgetTotal) * 100) : null });
    }
    const categories = Object.keys(window.KAKEIBO_CATEGORY_MAP).filter((cat) => cat !== '未分類').map((cat) => {
      const budget = budgetByCategory[cat] || 0, actual = actualByCategory[cat] || 0, actualGross = actualGrossByCategory[cat] || 0;
      return { category: cat, budget, actual, actualGross, pct: budget > 0 ? Math.round((actual / budget) * 100) : null, pctGross: budget > 0 ? Math.round((actualGross / budget) * 100) : null };
    });
    const ratioAtYearStart = ratioRows.length > 0 ? ratioRows[0] : null;
    const ratioKazuichi = ratioAtYearStart ? ratioAtYearStart.ratio_kazuichi : 0.5;
    const ratioNarumi = ratioAtYearStart ? ratioAtYearStart.ratio_narumi : 0.5;
    return { year, budgetTotal: yearBudgetTotal, actualTotal: yearActualTotal, actualGrossTotal: yearActualGrossTotal, pct: yearBudgetTotal > 0 ? Math.round((yearActualTotal / yearBudgetTotal) * 100) : null, pctGross: yearBudgetTotal > 0 ? Math.round((yearActualGrossTotal / yearBudgetTotal) * 100) : null, ratioKazuichi, ratioNarumi, projectedKazuichi: Math.round(yearBudgetTotal * ratioKazuichi), projectedNarumi: Math.round(yearBudgetTotal * ratioNarumi), months, categories, uncategorizedActual: actualByCategory['未分類'] || 0 };
  }

  async function fetchYearlyBudgetInputs_(year) {
    const [allRows, budgetRows, ratioRows, dedicatedNames] = await Promise.all([
      sb().from('transactions').select('occurred_at,category,amount,is_reimbursement,event_tag').gte('occurred_at', `${year}-01-01`).lt('occurred_at', `${Number(year) + 1}-01-01`).then(unwrap),
      sb().from('budgets').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      sb().from('settlement_ratios').select('*').lte('effective_from', `${year}-01-01`).order('effective_from', { ascending: false }).limit(1).then(unwrap),
      fetchDedicatedEventNames_()
    ]);
    const categoryRows = allRows.filter((row) => !row.event_tag || !dedicatedNames.has(row.event_tag));
    return { categoryRows, budgetRows, ratioRows };
  }
  async function getYearlyBudgetSummary(year) {
    const { categoryRows, budgetRows, ratioRows } = await fetchYearlyBudgetInputs_(year);
    return buildYearlyBudgetSummary_(year, categoryRows, budgetRows, ratioRows);
  }
  async function getBudgetScreenInitialData(year) {
    const [{ categoryRows, budgetRows, ratioRows }, eventRows, eventActualRows] = await Promise.all([
      fetchYearlyBudgetInputs_(year), fetchAllEvents(), fetchEventActuals()
    ]);
    return { yearlyData: buildYearlyBudgetSummary_(year, categoryRows, budgetRows, ratioRows), events: buildEventsWithActuals_(eventRows, eventActualRows) };
  }
  async function saveCategoryAnnualBudget(year, category, annualAmount) {
    const amount = Number(annualAmount);
    const base = Math.floor(amount / 12); const remainder = amount - base * 12;
    for (let m = 1; m <= 12; m++) {
      const yearMonth = `${year}-${String(m).padStart(2, '0')}-01`;
      const monthAmount = base + (m <= remainder ? 1 : 0);
      await upsertBudget({ category, year_month: yearMonth, budget_amount: monthAmount });
    }
    return getYearlyBudgetSummary(Number(year));
  }
  async function saveBudgets(yearMonth, amounts) {
    const keys = Object.keys(amounts).filter((c) => amounts[c] !== null && amounts[c] !== '' && amounts[c] !== undefined);
    await Promise.all(keys.map((category) => upsertBudget({ category, year_month: yearMonth, budget_amount: Number(amounts[category]) })));
  }

  // ---- イベント（gas/EventsClient.gs） ----
  function isFilled_(v) { return v !== null && v !== undefined && v !== ''; }
  function buildEventsWithActuals_(events, actualRows) {
    if (events.length === 0) return [];
    const actualByName = {};
    actualRows.forEach((row) => { actualByName[row.event_tag] = (actualByName[row.event_tag] || 0) + row.amount; });
    return events.map((e) => {
      const actual = actualByName[e.name] || 0;
      return {
        id: e.id, name: e.name, budget: e.budget_amount, actual,
        pct: (e.budget_amount != null && e.budget_amount > 0) ? Math.round((actual / e.budget_amount) * 100) : null,
        budgetScope: e.budget_scope || 'dedicated', startDate: e.start_date, endDate: e.end_date
      };
    });
  }
  async function listEventNames() { return (await fetchAllEvents()).map((e) => e.name); }
  async function listEventsWithActuals() {
    const events = await fetchAllEvents();
    if (events.length === 0) return [];
    return buildEventsWithActuals_(events, await fetchEventActuals());
  }
  // 期間内でまだevent_tagが付いていない取引を、DBトリガー経由のAI判定キューに乗せる。
  // ここで直接event_tagを設定するのではなく、occurred_atを「タッチ」して
  // queue_event_tag_classificationトリガー（AFTER UPDATE OF occurred_at）を起動させる。
  // 実際に関連する支出かどうかはevent-tag-classify Edge FunctionがGeminiで判定する
  async function backfillEventTagForRange_(eventName, startDate, endDate) {
    if (!startDate || !endDate) return;
    const rows = unwrap(await sb().from('transactions').select('id,occurred_at')
      .is('event_tag', null).gte('occurred_at', startDate).lte('occurred_at', endDate));
    for (const row of rows) {
      await sb().from('transactions').update({ occurred_at: row.occurred_at }).eq('id', row.id);
    }
  }
  async function saveEvent(payload) {
    if (!payload.name) throw new Error('イベント名を入力してください。');
    const budgetScope = payload.budgetScope === 'category' ? 'category' : 'dedicated';
    const record = {
      name: payload.name,
      budget_amount: (budgetScope === 'dedicated' && isFilled_(payload.budgetAmount)) ? Number(payload.budgetAmount) : null,
      budget_scope: budgetScope,
      start_date: payload.startDate || null,
      end_date: payload.endDate || null
    };
    const saved = payload.id ? await updateEvent(payload.id, record) : await insertEvent(record);
    await backfillEventTagForRange_(saved.name, record.start_date, record.end_date);
    return saved;
  }
  async function removeEvent(id) { return deleteEvent(id); }

  // ---- 分析・ホーム（gas/AnalysisClient.gs） ----
  function previousMonthKey_(today) {
    const d = new Date(today + 'T00:00:00'); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return fmt(d, 'yyyy-MM-dd');
  }
  function pctOf_(actual, budget) { return (budget !== null && budget > 0) ? Math.round((actual / budget) * 100) : null; }
  const AMOUNT_VARIANT_KEYS_ = ['amount', 'amount_gross', 'amount_excl_event', 'amount_gross_excl_event'];
  const ACTUAL_FIELD_NAMES_ = ['actual', 'actualGross', 'actualExclEvent', 'actualGrossExclEvent'];
  const PCT_FIELD_NAMES_ = ['pct', 'pctGross', 'pctExclEvent', 'pctGrossExclEvent'];
  const BUDGET_ACTUAL_COLS_ = ['actual_amount', 'actual_amount_gross', 'actual_amount_excl_event', 'actual_amount_gross_excl_event'];

  function buildCategoryBudgetBreakdown_(categoryRows, budgetActualRows) {
    const actualByCategory = {}, subByCategory = {};
    categoryRows.forEach((row) => {
      const sums = actualByCategory[row.category] || (actualByCategory[row.category] = [0, 0, 0, 0]);
      AMOUNT_VARIANT_KEYS_.forEach((key, i) => { sums[i] += row[key] || 0; });
      if (row.subcategory) {
        subByCategory[row.category] = subByCategory[row.category] || {};
        subByCategory[row.category][row.subcategory] = (subByCategory[row.category][row.subcategory] || 0) + row.amount;
      }
    });
    const budgetByCategory = {};
    budgetActualRows.forEach((row) => { budgetByCategory[row.category] = (budgetByCategory[row.category] || 0) + row.budget_amount; });
    return Object.keys(actualByCategory).map((category) => {
      const sums = actualByCategory[category];
      const budget = budgetByCategory[category] !== undefined ? budgetByCategory[category] : null;
      const subMap = subByCategory[category] || {};
      const subcategories = Object.keys(subMap).map((sub) => ({ subcategory: sub, amount: subMap[sub] })).sort((a, b) => b.amount - a.amount);
      const entry = { category, budget, subcategories };
      ACTUAL_FIELD_NAMES_.forEach((name, i) => { entry[name] = sums[i]; });
      PCT_FIELD_NAMES_.forEach((name, i) => { entry[name] = pctOf_(sums[i], budget); });
      return entry;
    }).sort((a, b) => b.actual - a.actual);
  }

  async function getUnclassifiedSummary() {
    const rows = await fetchUnclassifiedTransactions();
    return { count: rows.length, earliestYear: rows.length > 0 ? Number(rows[0].occurred_at.slice(0, 4)) : null };
  }
  async function getReviewScreenData() {
    const [unclassifiedRows, reviewRows, eventNames] = await Promise.all([
      fetchUnclassifiedTransactions(), fetchEventReviewQueue(), listEventNames()
    ]);
    return { unclassified: unclassifiedRows, eventReview: reviewRows, eventNames };
  }
  async function resolveUnclassifiedCategory(id, category, subcategory) {
    await updateTransaction(id, { category, subcategory: subcategory || null });
  }
  async function resolveEventReview(transactionId, eventName) {
    if (eventName) await updateTransaction(transactionId, { event_tag: eventName });
    unwrap(await sb().from('event_tag_review_queue').delete().eq('transaction_id', transactionId));
  }
  async function getNewAutoImports(sinceTimestamp) {
    const rows = await fetchAutoImportsSince(sinceTimestamp);
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    return { count: rows.length, total, items: rows.slice(0, 8), latestCreatedAt: rows.length > 0 ? rows[0].created_at : sinceTimestamp };
  }
  async function getHomeBanners(sinceTimestamp) {
    const today = todayStr();
    const prevMonthYm = previousMonthKey_(today);
    const dayOfMonth = Number(today.slice(8, 10));
    const [unclassifiedRows, reviewRows, autoImportRows, prevSettlementRows, prevConfirmationRows] = await Promise.all([
      fetchUnclassifiedTransactions(), fetchEventReviewQueue(), fetchAutoImportsSince(sinceTimestamp),
      sb().from('settlement_summary').select('*').eq('year_month', prevMonthYm).then(unwrap),
      sb().from('settlement_confirmations').select('*').eq('year_month', prevMonthYm).then(unwrap)
    ]);
    const unclassified = { count: unclassifiedRows.length, earliestYear: unclassifiedRows.length > 0 ? Number(unclassifiedRows[0].occurred_at.slice(0, 4)) : null };
    const eventReview = { count: reviewRows.length };
    const needsReview = { total: unclassified.count + eventReview.count, unclassifiedCount: unclassified.count, eventReviewCount: eventReview.count };
    const autoImportTotal = autoImportRows.reduce((sum, r) => sum + Number(r.amount), 0);
    const autoImports = { count: autoImportRows.length, total: autoImportTotal, items: autoImportRows.slice(0, 8), latestCreatedAt: autoImportRows.length > 0 ? autoImportRows[0].created_at : sinceTimestamp };
    const prevHadSpending = prevSettlementRows.length > 0 && prevSettlementRows[0].total_shared_amount > 0;
    const prevConfirmed = prevConfirmationRows.length > 0;
    const unconfirmedSettlement = (prevHadSpending && !prevConfirmed && dayOfMonth >= 5) ? { yearMonth: prevMonthYm, totalSharedAmount: prevSettlementRows[0].total_shared_amount } : null;
    return { unclassified, eventReview, needsReview, autoImports, unconfirmedSettlement };
  }
  async function getMultiYearTrend() {
    const thisYear = Number(fmt(new Date(), 'yyyy'));
    const startYear = thisYear - 4;
    const rows = unwrap(await sb().from('monthly_category_summary').select('year_month,amount').gte('year_month', `${startYear}-01-01`));
    const totalsByYear = {};
    for (let y = startYear; y <= thisYear; y++) totalsByYear[y] = 0;
    rows.forEach((row) => { const y = Number(row.year_month.slice(0, 4)); if (totalsByYear[y] === undefined) return; totalsByYear[y] += row.amount; });
    let series = Object.keys(totalsByYear).sort().map((y) => ({ year: Number(y), amount: totalsByYear[y] }));
    while (series.length > 1 && series[0].amount === 0 && series[0].year !== thisYear) series.shift();
    return { series };
  }
  async function getMonthlyCategorySummary(yearMonth) {
    const rows = await fetchMonthlyCategorySummaryRows(yearMonth);
    const byCategory = {};
    rows.forEach((row) => { byCategory[row.category] = (byCategory[row.category] || 0) + row.amount; });
    const total = Object.values(byCategory).reduce((sum, v) => sum + v, 0);
    const categories = Object.keys(byCategory).map((category) => ({ category, amount: byCategory[category], pct: total > 0 ? Math.round((byCategory[category] / total) * 100) : 0 })).sort((a, b) => b.amount - a.amount);
    return { yearMonth, total, categories };
  }
  async function getSubcategorySummary(yearMonth, category) {
    const rows = (await fetchMonthlyCategorySummaryRows(yearMonth)).filter((row) => row.category === category);
    const categoryTotal = rows.reduce((sum, row) => sum + row.amount, 0);
    return rows.map((row) => ({ subcategory: row.subcategory || '（サブカテゴリなし）', amount: row.amount, pct: categoryTotal > 0 ? Math.round((row.amount / categoryTotal) * 100) : 0 })).sort((a, b) => b.amount - a.amount);
  }
  async function getYearlyTrendFixed(year) {
    const rows = await fetchMonthlyCategorySummaryRange(`${year}-01-01`, `${year}-12-01`);
    const byMonth = {};
    for (let m = 1; m <= 12; m++) byMonth[`${year}-${String(m).padStart(2, '0')}-01`] = 0;
    rows.forEach((row) => { byMonth[row.year_month] = (byMonth[row.year_month] || 0) + row.amount; });
    const series = Object.keys(byMonth).sort().map((ym) => ({ yearMonth: ym, amount: byMonth[ym] }));
    const total = series.reduce((sum, m) => sum + m.amount, 0);
    return { year: Number(year), series, total, average: Math.round(total / 12) };
  }

  async function getHomeMonthOverview(yearMonth) {
    const [categoryRows, budgetActualRows, settlementRows, confirmationRows] = await Promise.all([
      fetchMonthlyCategorySummaryRows(yearMonth),
      sb().from('budget_vs_actual').select('*').eq('year_month', yearMonth).then(unwrap),
      sb().from('settlement_summary').select('*').eq('year_month', yearMonth).then(unwrap),
      sb().from('settlement_confirmations').select('*').eq('year_month', yearMonth).then(unwrap)
    ]);
    const categories = buildCategoryBudgetBreakdown_(categoryRows, budgetActualRows);
    const spendTotals = {}; ACTUAL_FIELD_NAMES_.forEach((name) => { spendTotals[name] = categories.reduce((sum, c) => sum + c[name], 0); });
    const budgetTotal = budgetActualRows.reduce((sum, row) => sum + row.budget_amount, 0);
    const budgetActualTotals = {};
    ACTUAL_FIELD_NAMES_.forEach((name, i) => { budgetActualTotals[name] = budgetActualRows.reduce((sum, row) => sum + (row[BUDGET_ACTUAL_COLS_[i]] || 0), 0); });
    const settlementRow = settlementRows.length > 0 ? settlementRows[0] : null;
    const settlement = confirmationRows.length > 0 ? buildConfirmedSettlementSummary_(yearMonth, confirmationRows[0]) : await buildSettlementSummary_(yearMonth, settlementRow);
    attachComparisonVariants_(settlement, settlementRow);
    const budget = { total: budgetTotal };
    ACTUAL_FIELD_NAMES_.forEach((name) => { budget[name] = budgetActualTotals[name]; });
    PCT_FIELD_NAMES_.forEach((name, i) => { budget[name] = pctOf_(budgetActualTotals[ACTUAL_FIELD_NAMES_[i]], budgetTotal); });
    return { yearMonth, spendTotal: spendTotals.actual, spendTotalGross: spendTotals.actualGross, spendTotalExclEvent: spendTotals.actualExclEvent, spendTotalGrossExclEvent: spendTotals.actualGrossExclEvent, budget, settlement, categories };
  }

  async function getHomeYearOverview(year) {
    const [categoryRows, budgetActualRows, settlementRows, confirmationRows] = await Promise.all([
      sb().from('monthly_category_summary').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      sb().from('budget_vs_actual').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      sb().from('settlement_summary').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      fetchSettlementConfirmationsForYear(year)
    ]);
    const categories = buildCategoryBudgetBreakdown_(categoryRows, budgetActualRows);
    const spendTotals = {}; ACTUAL_FIELD_NAMES_.forEach((name) => { spendTotals[name] = categories.reduce((sum, c) => sum + c[name], 0); });
    const budgetTotal = budgetActualRows.reduce((sum, row) => sum + row.budget_amount, 0);
    const budgetActualTotals = {};
    ACTUAL_FIELD_NAMES_.forEach((name, i) => { budgetActualTotals[name] = budgetActualRows.reduce((sum, row) => sum + (row[BUDGET_ACTUAL_COLS_[i]] || 0), 0); });
    const trendByMonth = {};
    for (let m = 1; m <= 12; m++) trendByMonth[`${year}-${String(m).padStart(2, '0')}-01`] = 0;
    categoryRows.forEach((row) => { trendByMonth[row.year_month] = (trendByMonth[row.year_month] || 0) + row.amount; });
    const trendSeries = Object.keys(trendByMonth).sort().map((ym) => ({ yearMonth: ym, amount: trendByMonth[ym] }));
    const trendTotal = trendSeries.reduce((sum, m) => sum + m.amount, 0);
    const trend = { year: Number(year), series: trendSeries, total: trendTotal, average: Math.round(trendTotal / 12) };
    const confirmedYearMonths = {}; let netDiffKazuichi = 0;
    confirmationRows.forEach((c) => { confirmedYearMonths[c.year_month] = true; netDiffKazuichi += c.diff_kazuichi; });
    settlementRows.forEach((row) => {
      if (confirmedYearMonths[row.year_month]) return;
      const result = calculateSettlement(row.total_shared_amount, row.paid_kazuichi || 0, row.paid_narumi || 0, row.ratio_kazuichi, row.ratio_narumi, row.owed_by_kazuichi || 0, row.owed_by_narumi || 0);
      netDiffKazuichi += result.diffKazuichi;
    });
    let grossDiffKazuichi = 0, exclEventDiffKazuichi = 0, grossExclEventDiffKazuichi = 0;
    settlementRows.forEach((row) => {
      grossDiffKazuichi += calculateSettlementVariant_(row, '_gross').diffKazuichi;
      exclEventDiffKazuichi += calculateSettlementVariant_(row, '_excl_event').diffKazuichi;
      grossExclEventDiffKazuichi += calculateSettlementVariant_(row, '_gross_excl_event').diffKazuichi;
    });
    const diffToTransfer = (diff) => ({ transferFrom: diff >= 0 ? '成美' : '一', transferTo: diff >= 0 ? '一' : '成美', transferAmount: Math.round(Math.abs(diff)) });
    const net = diffToTransfer(netDiffKazuichi);
    const budget = { total: budgetTotal };
    ACTUAL_FIELD_NAMES_.forEach((name) => { budget[name] = budgetActualTotals[name]; });
    PCT_FIELD_NAMES_.forEach((name, i) => { budget[name] = pctOf_(budgetActualTotals[ACTUAL_FIELD_NAMES_[i]], budgetTotal); });
    return {
      year: Number(year), spendTotal: spendTotals.actual, spendTotalGross: spendTotals.actualGross, spendTotalExclEvent: spendTotals.actualExclEvent, spendTotalGrossExclEvent: spendTotals.actualGrossExclEvent,
      budget, settlement: { transferFrom: net.transferFrom, transferTo: net.transferTo, transferAmount: net.transferAmount, gross: diffToTransfer(grossDiffKazuichi), exclEvent: diffToTransfer(exclEventDiffKazuichi), grossExclEvent: diffToTransfer(grossExclEventDiffKazuichi), confirmedMonthsCount: confirmationRows.length },
      categories, trend
    };
  }

  // ---- 定期収支（gas/RecurringExpense.gs） ----
  function groupSplitRatioKazuichi_(group) {
    if (group.amount_kazuichi != null && group.amount_narumi != null) {
      const total = Number(group.amount_kazuichi) + Number(group.amount_narumi);
      return total === 0 ? null : Number(group.amount_kazuichi) / total;
    }
    if (group.ratio_kazuichi != null && group.ratio_narumi != null) {
      const total = Number(group.ratio_kazuichi) + Number(group.ratio_narumi);
      return total === 0 ? null : Number(group.ratio_kazuichi) / total;
    }
    return null;
  }
  function computeBackfillOccurrences_(group, expense, today, generatedMonthKeys) {
    const results = [];
    const startDate = new Date(group.start_date + 'T00:00:00');
    const endLimit = group.end_date ? new Date(group.end_date + 'T00:00:00') : null;
    const todayDate = new Date(today + 'T00:00:00');
    let y = startDate.getFullYear(), m = startDate.getMonth();
    while (y < todayDate.getFullYear() || (y === todayDate.getFullYear() && m <= todayDate.getMonth())) {
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const day = Math.min(Number(expense.day_of_month), daysInMonth);
      const occurredDate = new Date(y, m, day);
      const occurredAt = fmt(occurredDate, 'yyyy-MM-dd');
      const monthKey = fmt(occurredDate, 'yyyy-MM');
      const withinGroupPeriod = occurredDate >= startDate && (!endLimit || occurredDate <= endLimit);
      const notInFuture = occurredAt <= today;
      if (withinGroupPeriod && notInFuture && !generatedMonthKeys[monthKey]) results.push(occurredAt);
      m += 1; if (m > 11) { m = 0; y += 1; }
    }
    return results;
  }
  function buildTransactionRecordsForExpense_(expense, group, occurredAt) {
    const ratioKazuichi = groupSplitRatioKazuichi_(group);
    const base = { occurred_at: occurredAt, category: expense.category, subcategory: expense.subcategory, name: expense.name, paid_by: expense.paid_by, source_channel: 'recurring_auto', is_recurring_generated: true, recurring_expense_id: expense.id, is_reimbursement: !!expense.is_reimbursement };
    if (ratioKazuichi == null) return [Object.assign({}, base, { amount: expense.amount, billed_to: '共用' })];
    const amountKazuichi = Math.round(expense.amount * ratioKazuichi);
    const amountNarumi = expense.amount - amountKazuichi;
    return [{ billedTo: '一', amount: amountKazuichi }, { billedTo: '成美', amount: amountNarumi }]
      .filter((share) => share.amount !== 0)
      .map((share) => Object.assign({}, base, { amount: share.amount, billed_to: share.billedTo }));
  }
  async function resyncRecurringExpense_(expense, group, confirmedMonths) {
    const existing = await fetchTransactionsByRecurringExpenseAll(expense.id);
    let skippedConfirmed = 0; const idsToDelete = []; const keepMonthKeys = {};
    existing.forEach((t) => {
      const monthKey = String(t.occurred_at).slice(0, 7);
      if (confirmedMonths[monthKey]) { skippedConfirmed++; keepMonthKeys[monthKey] = true; } else { idsToDelete.push(t.id); }
    });
    await deleteTransactionsByIds(idsToDelete);
    const today = todayStr();
    const targetDates = computeBackfillOccurrences_(group, expense, today, keepMonthKeys);
    let records = [];
    targetDates.forEach((occurredAt) => { records = records.concat(buildTransactionRecordsForExpense_(expense, group, occurredAt)); });
    await insertTransactionsBulk(records);
    return { regenerated: targetDates.length, skippedConfirmed };
  }
  async function resyncRecurringExpense(recurringExpenseId) {
    const expense = await fetchRecurringExpenseById(recurringExpenseId);
    if (!expense) throw new Error('定期支出項目が見つかりません。');
    const group = await fetchRecurringExpenseGroupById(expense.group_id);
    if (!group) throw new Error('所属グループが見つかりません。');
    return resyncRecurringExpense_(expense, group, await fetchAllConfirmedMonthKeys());
  }
  async function resyncRecurringExpenseGroup(groupId) {
    const group = await fetchRecurringExpenseGroupById(groupId);
    if (!group) throw new Error('グループが見つかりません。');
    const items = await fetchRecurringExpensesByGroup(groupId);
    const confirmedMonths = await fetchAllConfirmedMonthKeys();
    let regenerated = 0, skippedConfirmed = 0;
    for (const expense of items) {
      const result = await resyncRecurringExpense_(expense, group, confirmedMonths);
      regenerated += result.regenerated; skippedConfirmed += result.skippedConfirmed;
    }
    return { regenerated, skippedConfirmed, itemCount: items.length };
  }
  async function listRecurringExpenses() { return fetchAllRecurringExpenses(); }
  async function getRecurringScreenInitialData() {
    const today = todayStr();
    const [groups, expenses, ratioRows] = await Promise.all([
      fetchAllRecurringExpenseGroups(), fetchAllRecurringExpenses(),
      sb().from('settlement_ratios').select('*').lte('effective_from', today).order('effective_from', { ascending: false }).limit(1).then(unwrap)
    ]);
    const ratio = ratioRows.length > 0 ? { ratioKazuichi: Number(ratioRows[0].ratio_kazuichi), ratioNarumi: Number(ratioRows[0].ratio_narumi) } : { ratioKazuichi: 0.5, ratioNarumi: 0.5 };
    return { groups, expenses, ratio };
  }
  async function saveRecurringExpense(payload) {
    if (!payload.groupId) throw new Error('グループを選択してください。');
    const record = { category: payload.category, subcategory: payload.subcategory || null, name: payload.name, amount: Number(payload.amount), day_of_month: Number(payload.dayOfMonth), paid_by: payload.paidBy, group_id: payload.groupId, is_reimbursement: !!payload.isReimbursement };
    const saved = payload.id ? await updateRecurringExpense(payload.id, record) : await insertRecurringExpense(record);
    let resync = null;
    try { resync = await resyncRecurringExpense(saved.id); } catch (e) { console.error(e); }
    saved.resync = resync;
    return saved;
  }
  async function deactivateRecurringExpense(id) { return updateRecurringExpense(id, { active: false }); }
  async function removeRecurringExpense(id) {
    try { await deleteRecurringExpense(id); } catch (err) {
      if (String(err.message).indexOf('transactions') !== -1 || String(err.message).indexOf('foreign key') !== -1) {
        throw new Error('この項目からは既に取引が自動計上されているため削除できません。過去の実績を残したい場合は「無効化」を使ってください。');
      }
      throw err;
    }
  }
  async function listRecurringExpenseGroups() { return fetchAllRecurringExpenseGroups(); }
  async function saveRecurringExpenseGroup(payload) {
    if (!payload.startDate) throw new Error('開始日を入力してください。');
    const record = { name: payload.name, start_date: payload.startDate, end_date: payload.endDate || null, amount_kazuichi: null, amount_narumi: null, ratio_kazuichi: null, ratio_narumi: null };
    const mode = payload.splitMode || 'auto';
    if (mode === 'fixed') {
      if (!isFilled_(payload.amountKazuichi) || !isFilled_(payload.amountNarumi)) throw new Error('固定分担額は一・成美の両方を入力してください。');
      record.amount_kazuichi = Number(payload.amountKazuichi); record.amount_narumi = Number(payload.amountNarumi);
    } else if (mode === 'ratio') {
      if (!isFilled_(payload.ratioKazuichi) || !isFilled_(payload.ratioNarumi)) throw new Error('比率は一・成美の両方を入力してください。');
      const rk = Number(payload.ratioKazuichi), rn = Number(payload.ratioNarumi);
      if (Math.abs(rk + rn - 1) > 0.001) throw new Error('比率の合計が100%になるように入力してください。');
      record.ratio_kazuichi = rk; record.ratio_narumi = rn;
    }
    const saved = payload.id ? await updateRecurringExpenseGroup(payload.id, record) : await insertRecurringExpenseGroup(record);
    let resync = null;
    try { resync = await resyncRecurringExpenseGroup(saved.id); } catch (e) { console.error(e); }
    saved.resync = resync;
    return saved;
  }
  async function getCurrentSettlementRatioForGroup() {
    const row = await fetchSettlementRatioForMonth(todayStr());
    if (!row) return { ratioKazuichi: 0.5, ratioNarumi: 0.5 };
    return { ratioKazuichi: Number(row.ratio_kazuichi), ratioNarumi: Number(row.ratio_narumi) };
  }
  async function removeRecurringExpenseGroup(id) {
    try { await deleteRecurringExpenseGroup(id); } catch (err) {
      if (String(err.message).indexOf('recurring_expenses') !== -1 || String(err.message).indexOf('foreign key') !== -1) {
        throw new Error('このグループには定期支出の項目がまだ紐づいているため削除できません。先に各項目を別のグループへ付け替えてください。');
      }
      throw err;
    }
  }

  // ---- 履歴・表編集（gas/HistoryClient.gs） ----
  const HISTORY_LIST_LIMIT = 30;
  async function listRecentTransactions() { return fetchRecentTransactions(HISTORY_LIST_LIMIT); }
  async function saveTransactionEdit(id, payload) {
    const patch = { occurred_at: payload.occurredAt, category: payload.category, subcategory: payload.subcategory || null, name: payload.name || '', amount: Number(payload.amount), paid_by: payload.paidBy || null, billed_to: payload.billedTo || '共用' };
    await updateTransaction(id, patch);
    return listRecentTransactions();
  }
  async function deleteTransactionById(id) { await deleteTransaction(id); return listRecentTransactions(); }
  async function listTransactionsForYear(year) { return fetchTransactionsForYear(year); }
  async function listAllTransactionsForExport() { return fetchAllTransactions(); }
  async function updateTransactionField(id, field, value) {
    const allowedFields = ['occurred_at', 'category', 'subcategory', 'paid_by', 'billed_to', 'amount', 'name', 'event_tag'];
    if (allowedFields.indexOf(field) === -1) throw new Error('不正なフィールドです: ' + field);
    const patch = {}; patch[field] = (field === 'amount') ? Number(value) : (value === '' ? null : value);
    return updateTransaction(id, patch);
  }

  // ---- LIFF入力フォーム用 ----
  async function submitTransactionFromLiff(payload) {
    const record = { occurred_at: payload.occurredAt, category: payload.category, subcategory: payload.subcategory || null, name: payload.name || '', amount: Number(payload.amount), paid_by: payload.paidBy, billed_to: payload.billedTo || '共用', source_channel: 'line_manual', is_reimbursement: !!payload.isReimbursement };
    const result = await insertTransactionWithDuplicateCheck_(record, 'line_manual');
    if (result.duplicate) {
      console.warn('重複の可能性があります', record, result.duplicate);
    }
    return { status: 'ok', id: result.inserted.id };
  }

  // ---- 買い物リスト ----
  // 追加はshopping-classify Edge Function経由（Gemini分類のためAPIキーをクライアントに渡さない）
  async function getShoppingScreenData() {
    const [unpurchased, purchased] = await Promise.all([
      fetchUnpurchasedShoppingItems(), fetchPurchasedShoppingItems(30)
    ]);
    return { unpurchased, purchased };
  }
  async function addShoppingItemFromLiff(name) {
    const { data: { session } } = await sb().auth.getSession();
    const res = await fetch('https://gduznhcuyjxxyuhfexek.supabase.co/functions/v1/shopping-classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'shopping-classify failed');
    return data;
  }
  async function toggleShoppingItemPurchased(id, purchased) {
    return updateShoppingItem(id, { purchased_at: purchased ? new Date().toISOString() : null });
  }
  async function removeShoppingItem(id) {
    return deleteShoppingItem(id);
  }

  // ---- レシピ ----
  async function fetchRecipes() {
    const rows = unwrap(await sb().from('recipes').select('*, recipe_ingredients(count)').order('created_at', { ascending: false }));
    return rows.map((r) => ({
      id: r.id, name: r.name, sourceUrl: r.source_url, createdAt: r.created_at,
      ingredientCount: (r.recipe_ingredients && r.recipe_ingredients[0] && r.recipe_ingredients[0].count) || 0
    }));
  }
  async function fetchRecipeDetail(id) {
    const row = unwrap(await sb().from('recipes').select('*, recipe_ingredients(*)').eq('id', id)
      .order('sort_order', { foreignTable: 'recipe_ingredients', ascending: true }).single());
    return {
      id: row.id, name: row.name, sourceUrl: row.source_url, stepsText: row.steps_text,
      ingredients: (row.recipe_ingredients || []).map((i) => ({ id: i.id, name: i.name, quantity: i.quantity }))
    };
  }
  async function saveRecipe(payload) {
    // payload: { id?, name, sourceUrl, stepsText, ingredients: [{name, quantity}] }
    let recipeId = payload.id;
    const recipeRecord = { name: payload.name, source_url: payload.sourceUrl || null, steps_text: payload.stepsText || null };
    if (recipeId) {
      const res = await sb().from('recipes').update(recipeRecord).eq('id', recipeId);
      if (res.error) throw new Error(res.error.message);
      const delRes = await sb().from('recipe_ingredients').delete().eq('recipe_id', recipeId);
      if (delRes.error) throw new Error(delRes.error.message);
    } else {
      recipeId = unwrap(await sb().from('recipes').insert(recipeRecord).select())[0].id;
    }
    const ingredientRows = (payload.ingredients || [])
      .filter((i) => i.name && i.name.trim())
      .map((i, idx) => ({ recipe_id: recipeId, name: i.name.trim(), quantity: i.quantity || null, sort_order: idx }));
    if (ingredientRows.length > 0) {
      const res = await sb().from('recipe_ingredients').insert(ingredientRows);
      if (res.error) throw new Error(res.error.message);
    }
    return recipeId;
  }
  async function deleteRecipe(id) {
    const res = await sb().from('recipes').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message);
  }
  // AI抽出はrecipe-extract Edge Function経由（GeminiのAPIキーをクライアントに渡さないため。
  // shopping-classifyと同じ「セッショントークンをAuthorizationに載せて直接fetch」パターン）
  async function extractRecipeFromInput(rawInput) {
    const { data: { session } } = await sb().auth.getSession();
    const res = await fetch('https://gduznhcuyjxxyuhfexek.supabase.co/functions/v1/recipe-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ rawInput })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'recipe-extract failed');
    return data;
  }
  // 材料の買い物リスト追加は、既存のshopping-classify Edge Function（重複チェック＋Geminiでの
  // カテゴリ分類込み）をそのまま1品ずつ並列で呼び出す。新しい挿入ロジックを別途持たない
  async function addRecipeIngredientsToShoppingList(names) {
    return Promise.all(names.map((n) => addShoppingItemFromLiff(n)));
  }

  // ---- 資産管理 ----
  function buildAssetDateGroups_(snapshotRows) {
    const byDate = {};
    snapshotRows.forEach((row) => {
      if (!row.asset_items) return; // 参照先プリセットが削除済み（通常は起きない、asset_itemsはdeactivateのみ）
      if (!byDate[row.as_of_date]) byDate[row.as_of_date] = [];
      byDate[row.as_of_date].push({
        id: row.id, assetItemId: row.asset_item_id, amount: row.amount,
        person: row.asset_items.person, category: row.asset_items.category, institution: row.asset_items.institution,
        itemType: row.asset_items.item_type || 'asset'
      });
    });
    return byDate;
  }

  // ---- 資産項目の詳細条件（定期預金の単利評価額／住宅ローン等の元利均等残高を自動計算） ----
  async function fetchAssetTermConditions() {
    return unwrap(await sb().from('asset_term_conditions').select('*'));
  }
  async function saveAssetTermConditions(assetItemId, payload) {
    const record = {
      asset_item_id: assetItemId,
      principal: Number(payload.principal),
      annual_rate_percent: Number(payload.annualRatePercent),
      term_years: Number(payload.termYears),
      start_date: payload.startDate
    };
    // linkedPropertyAssetItemIdが渡されなかった場合はキー自体を含めず、upsert時に既存の紐付けを
    // 上書きしない（資産項目の管理画面の簡易フォームからの保存で、ローン詳細ページで設定した
    // 紐付けが毎回nullに戻ってしまうのを防ぐ）
    if (payload.linkedPropertyAssetItemId !== undefined) {
      record.linked_property_asset_item_id = payload.linkedPropertyAssetItemId || null;
    }
    return unwrap(await sb().from('asset_term_conditions').upsert(record, { onConflict: 'asset_item_id' }).select())[0];
  }
  async function removeAssetTermConditions(assetItemId) {
    unwrap(await sb().from('asset_term_conditions').delete().eq('asset_item_id', assetItemId));
  }
  async function fetchAllLoanRateChanges() {
    return unwrap(await sb().from('asset_loan_rate_changes').select('*').order('effective_date', { ascending: true }));
  }
  async function saveLoanRateChange(assetItemId, payload) {
    return unwrap(await sb().from('asset_loan_rate_changes')
      .insert({ asset_item_id: assetItemId, effective_date: payload.effectiveDate, annual_rate_percent: Number(payload.annualRatePercent) })
      .select())[0];
  }
  async function removeLoanRateChange(id) {
    unwrap(await sb().from('asset_loan_rate_changes').delete().eq('id', id));
  }

  function monthsElapsed_(startDate, asOfDate) {
    const s = new Date(startDate + 'T00:00:00'), a = new Date(asOfDate + 'T00:00:00');
    let months = (a.getFullYear() - s.getFullYear()) * 12 + (a.getMonth() - s.getMonth());
    if (a.getDate() < s.getDate()) months -= 1;
    return Math.max(0, months);
  }
  // 金利変更履歴から「返済開始月から効力を持つ利率」の区間リストを組み立てる（昇順）
  function buildRateSegments_(term, rateChanges) {
    const segs = [{ startDate: term.start_date, rate: Number(term.annual_rate_percent) }];
    (rateChanges || []).slice().sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1)).forEach((rc) => {
      if (rc.effective_date > term.start_date) segs.push({ startDate: rc.effective_date, rate: Number(rc.annual_rate_percent) });
    });
    return segs;
  }
  // 住宅ローン等（負債）：金利変更のたびに「その時点の残高・残り期間」で返済額を再計算する
  // リキャスト方式。日本の変動金利ローンの5年ルール・125%ルールは対象外（単純化のため）
  function computeLoanRemainingBalance_(term, rateChanges, asOfDate) {
    const totalMonths = term.term_years * 12;
    const segments = buildRateSegments_(term, rateChanges);
    let balance = term.principal, monthsElapsedTotal = 0;
    for (let i = 0; i < segments.length; i++) {
      const remainingMonths = totalMonths - monthsElapsedTotal;
      if (remainingMonths <= 0) { balance = 0; break; }
      const segStart = segments[i].startDate;
      const segEnd = (i + 1 < segments.length) ? segments[i + 1].startDate : null;
      if (asOfDate < segStart) break;
      const r = segments[i].rate / 100 / 12;
      const n = remainingMonths;
      const segEndForCalc = (segEnd && segEnd < asOfDate) ? segEnd : asOfDate;
      const k = Math.min(monthsElapsed_(segStart, segEndForCalc), n);
      if (k <= 0) break;
      if (k >= n) { balance = 0; monthsElapsedTotal += n; break; }
      balance = (r === 0) ? balance - (balance / n) * k : balance * (Math.pow(1 + r, n) - Math.pow(1 + r, k)) / (Math.pow(1 + r, n) - 1);
      monthsElapsedTotal += k;
      if (!segEnd || segEnd > asOfDate) break;
    }
    return Math.round(Math.max(0, balance));
  }
  // 定期預金等（資産）：単利で満期までの評価額を経過期間で按分（満期後は満期額で頭打ち）
  function computeAssetTermValue_(term, asOfDate) {
    const elapsedMonths = Math.min(monthsElapsed_(term.start_date, asOfDate), term.term_years * 12);
    const elapsedYears = elapsedMonths / 12;
    const rate = term.annual_rate_percent / 100;
    return Math.round(term.principal * (1 + rate * elapsedYears));
  }
  function computeTermForecastValue_(itemType, term, rateChanges, asOfDate) {
    if (!term) return null;
    return itemType === 'liability' ? computeLoanRemainingBalance_(term, rateChanges, asOfDate) : computeAssetTermValue_(term, asOfDate);
  }
  function termMaturityDate_(term) {
    const d = new Date(term.start_date + 'T00:00:00');
    d.setFullYear(d.getFullYear() + term.term_years);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }

  // ローン単独の月別返済予定表（借入開始から完済まで全期間）を生成する。一覧画面の予測残高
  // 表示（computeLoanRemainingBalance_、スカラー値のみ）とは別に、ローン詳細ページの
  // 表・グラフ用に全月の内訳を持つ配列を作る
  function buildAmortizationSchedule_(term, rateChanges) {
    const totalMonths = term.term_years * 12;
    const segments = buildRateSegments_(term, rateChanges);
    const schedule = [];
    let balance = term.principal, monthIndex = 0, curDate = new Date(term.start_date + 'T00:00:00');
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segRate = segments[segIdx].rate;
      const remainingMonths = totalMonths - monthIndex;
      if (remainingMonths <= 0) break;
      const r = segRate / 100 / 12, n = remainingMonths;
      const monthlyPayment = (r === 0) ? balance / n : balance * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
      const nextSegStart = (segIdx + 1 < segments.length) ? new Date(segments[segIdx + 1].startDate + 'T00:00:00') : null;
      for (let m = 0; m < remainingMonths; m++) {
        const payDate = new Date(curDate); payDate.setMonth(payDate.getMonth() + 1);
        if (nextSegStart && payDate.getTime() > nextSegStart.getTime()) break;
        const interest = (r === 0) ? 0 : balance * r;
        let principalPaid = monthlyPayment - interest;
        if (principalPaid > balance) principalPaid = balance;
        balance = Math.max(0, balance - principalPaid);
        schedule.push({
          date: payDate.toISOString().slice(0, 10), rate: segRate,
          payment: Math.round(monthlyPayment), principalPaid: Math.round(principalPaid),
          interestPaid: Math.round(interest), balance: Math.round(balance)
        });
        monthIndex++; curDate = payDate;
        if (balance <= 0) break;
      }
      if (balance <= 0) break;
    }
    return schedule;
  }
  function buildYearlySummaryFromSchedule_(schedule) {
    const byYear = {};
    schedule.forEach((row) => {
      const y = row.date.slice(0, 4);
      if (!byYear[y]) byYear[y] = { year: Number(y), principalPaid: 0, interestPaid: 0, endBalance: 0, rates: new Set() };
      byYear[y].principalPaid += row.principalPaid;
      byYear[y].interestPaid += row.interestPaid;
      byYear[y].endBalance = row.balance;
      byYear[y].rates.add(row.rate);
    });
    return Object.keys(byYear).sort().map((y) => {
      const e = byYear[y];
      return { year: e.year, principalPaid: e.principalPaid, interestPaid: e.interestPaid, endBalance: e.endBalance, rateChanged: e.rates.size > 1 };
    });
  }
  function scheduleEndDate_(schedule) {
    if (schedule.length === 0) return null;
    const d = new Date(schedule[schedule.length - 1].date + 'T00:00:00');
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }

  async function getLoanDetailScreenData(assetItemId) {
    const [items, allTermConditions, allRateChanges, allSnapshots] = await Promise.all([
      fetchAssetItems(false), fetchAssetTermConditions(), fetchAllLoanRateChanges(), fetchAllAssetSnapshots()
    ]);
    const item = items.find((i) => i.id === assetItemId);
    if (!item) throw new Error('項目が見つかりません');
    const term = allTermConditions.find((t) => t.asset_item_id === assetItemId);
    if (!term) throw new Error('詳細条件が設定されていません');
    const rateChanges = allRateChanges.filter((rc) => rc.asset_item_id === assetItemId);
    const schedule = buildAmortizationSchedule_(term, rateChanges);
    const yearlySummary = buildYearlySummaryFromSchedule_(schedule);
    const today = todayStr();
    const currentBalance = computeLoanRemainingBalance_(term, rateChanges, today);
    const maturityDate = scheduleEndDate_(schedule) || termMaturityDate_(term);

    let linkedProperty = null;
    if (term.linked_property_asset_item_id) {
      const propItem = items.find((i) => i.id === term.linked_property_asset_item_id);
      if (propItem) {
        const byDate = buildAssetDateGroups_(allSnapshots);
        let latestAmount = null;
        Object.keys(byDate).sort().forEach((d) => {
          byDate[d].forEach((e) => { if (e.assetItemId === propItem.id) latestAmount = e.amount; });
        });
        linkedProperty = { id: propItem.id, name: propItem.category + '・' + propItem.institution, latestAmount };
      }
    }
    const propertyOptions = items.filter((i) => i.item_type !== 'liability' && i.category === '不動産' && i.active)
      .map((i) => ({ id: i.id, name: i.category + '・' + i.institution }));

    return { item, term, rateChanges, schedule, yearlySummary, currentBalance, maturityDate, linkedProperty, propertyOptions };
  }

  async function fetchAssetGoals() {
    return unwrap(await sb().from('asset_goals').select('*').order('created_at', { ascending: true }));
  }
  async function insertAssetGoal(record) {
    return unwrap(await sb().from('asset_goals').insert(record).select())[0];
  }
  async function removeAssetGoal(id) {
    unwrap(await sb().from('asset_goals').delete().eq('id', id));
  }
  async function saveAssetGoal(payload) {
    return insertAssetGoal({ name: payload.name, target_amount: Number(payload.targetAmount) });
  }

  // 直近の純資産推移（最初と最後の2点）から月あたりの平均増加額を算出する単純な線形モデル。
  // 複利・利回りは考慮しない（精度より分かりやすさを優先、資産形成シミュレーションで使用）
  function computeMonthlyNetWorthTrend_(netWorthHistory) {
    if (!netWorthHistory || netWorthHistory.length < 2) return null;
    const first = netWorthHistory[0], last = netWorthHistory[netWorthHistory.length - 1];
    const days = (new Date(last.date + 'T00:00:00') - new Date(first.date + 'T00:00:00')) / 86400000;
    const months = days / 30.44;
    if (months <= 0) return null;
    return (last.netWorth - first.netWorth) / months;
  }
  function projectGoalReach_(goal, latestNetWorth, monthlyAvgIncrease) {
    if (latestNetWorth >= goal.target_amount) return { status: 'reached' };
    if (monthlyAvgIncrease === null || monthlyAvgIncrease <= 0) return { status: 'no_projection' };
    const remaining = goal.target_amount - latestNetWorth;
    const monthsToGoal = remaining / monthlyAvgIncrease;
    const reachDate = new Date();
    reachDate.setMonth(reachDate.getMonth() + Math.ceil(monthsToGoal));
    return { status: 'projected', monthsToGoal, reachYear: reachDate.getFullYear(), reachMonth: reachDate.getMonth() + 1 };
  }

  async function getAssetScreenInitialData() {
    const [items, snapshotRows, goalsRaw, termConditionsRaw, rateChangesRaw] = await Promise.all([
      fetchAssetItems(false), fetchAllAssetSnapshots(), fetchAssetGoals(), fetchAssetTermConditions(), fetchAllLoanRateChanges()
    ]);
    const termByItem = {}; termConditionsRaw.forEach((t) => { termByItem[t.asset_item_id] = t; });
    const rateChangesByItem = {};
    rateChangesRaw.forEach((rc) => { (rateChangesByItem[rc.asset_item_id] = rateChangesByItem[rc.asset_item_id] || []).push(rc); });
    const today = todayStr();
    items.forEach((item) => {
      const term = termByItem[item.id] || null;
      item.termConditions = term;
      item.forecastValue = term ? computeTermForecastValue_(item.item_type, term, rateChangesByItem[item.id] || [], today) : null;
      item.maturityDate = term ? termMaturityDate_(term) : null;
    });
    const byDate = buildAssetDateGroups_(snapshotRows);
    const dates = Object.keys(byDate).sort();
    const dateSummaries = dates.map((d) => {
      const entries = byDate[d];
      const assetEntries = entries.filter((e) => e.itemType !== 'liability');
      const liabilityEntries = entries.filter((e) => e.itemType === 'liability');
      const assetTotal = assetEntries.reduce((s, e) => s + e.amount, 0);
      const liabilityTotal = liabilityEntries.reduce((s, e) => s + e.amount, 0);
      const byCategory = {}, byLiabilityCategory = {};
      assetEntries.forEach((e) => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
      liabilityEntries.forEach((e) => { byLiabilityCategory[e.category] = (byLiabilityCategory[e.category] || 0) + e.amount; });
      return { date: d, assetTotal, liabilityTotal, netWorth: assetTotal - liabilityTotal, byCategory, byLiabilityCategory, entries };
    });
    const latest = dateSummaries.length > 0 ? dateSummaries[dateSummaries.length - 1] : null;
    const previous = dateSummaries.length > 1 ? dateSummaries[dateSummaries.length - 2] : null;
    const trend = dateSummaries.slice(-6);

    // 項目ごとの直近金額（プリセット表示用）。dateSummariesは日付昇順なので、後の記録で
    // 上書きしていけば「その項目が最後に記録された時点の金額」になる（最新の日付に
    // その項目が含まれていなくても、それより前の記録があれば正しく拾える）
    const latestAmountByItem = {};
    dateSummaries.forEach((d) => { d.entries.forEach((e) => { latestAmountByItem[e.assetItemId] = e.amount; }); });

    const netWorthHistory = dateSummaries.slice(-12).map((d) => ({ date: d.date, netWorth: d.netWorth }));
    const monthlyAvgIncrease = computeMonthlyNetWorthTrend_(netWorthHistory);
    const latestNetWorth = latest ? latest.netWorth : 0;
    const goals = goalsRaw.map((g) => Object.assign(
      { id: g.id, name: g.name, targetAmount: g.target_amount },
      projectGoalReach_(g, latestNetWorth, monthlyAvgIncrease)
    ));

    return {
      items,
      dateSummariesDesc: dateSummaries.slice().reverse(),
      latest, previous, trend, latestAmountByItem,
      netWorthHistory, monthlyAvgIncrease, goals
    };
  }

  async function saveAssetItem(payload) {
    const record = {
      person: payload.person, category: payload.category, institution: payload.institution,
      item_type: payload.itemType === 'liability' ? 'liability' : 'asset',
      sort_order: payload.sortOrder || 0
    };
    if (payload.id) return updateAssetItem(payload.id, record);
    return insertAssetItem(record);
  }

  async function saveAssetSnapshot(asOfDate, entries) {
    return upsertAssetSnapshotBatch(asOfDate, entries);
  }

  // ---- サービス利用状況モニタリング ----
  // period_keyはEdge Function側（supabase/functions/_shared/gemini.ts等）が
  // new Date().toISOString().slice(...)で生成しているUTC基準の日付/年月と揃える必要があるため、
  // ここだけ他画面のようなAsia/Tokyo基準のfmt()は使わず、あえてUTC基準で作る
  function utcDayKey_() { return new Date().toISOString().slice(0, 10); }
  function utcMonthKey_() { return new Date().toISOString().slice(0, 7); }

  async function fetchDbSizeBytes() {
    const { data, error } = await sb().rpc('get_db_size_bytes');
    if (error) throw new Error(error.message);
    return Number(data);
  }
  async function fetchServiceUsageCounter_(service, periodKey) {
    const rows = unwrap(await sb().from('service_usage_counters').select('count').eq('service', service).eq('period_key', periodKey));
    return rows.length > 0 ? Number(rows[0].count) : 0;
  }
  async function getUsageMonitoringData() {
    const [dbSizeBytes, edgeFunctionInvocations, geminiRequests] = await Promise.all([
      fetchDbSizeBytes(),
      fetchServiceUsageCounter_('edge_function_invocations', utcMonthKey_()),
      fetchServiceUsageCounter_('gemini_requests', utcDayKey_())
    ]);
    return { dbSizeBytes, edgeFunctionInvocations, geminiRequests };
  }

  window.kakeiboData = {
    fmt, todayStr,
    // settlement
    calculateSettlement, getSettlementSummary, getYearlySettlementSummary, getSettlementScreenInitialData,
    confirmSettlementMonth, unconfirmSettlementMonth, saveNewRatio, saveNewYearRatio, getSettlementRatioPeriods,
    // budget
    getBudgetsForMonth, getYearlyBudgetSummary, getBudgetScreenInitialData, saveCategoryAnnualBudget, saveBudgets,
    // events
    listEventNames, listEventsWithActuals, saveEvent, removeEvent,
    // analysis / home
    getUnclassifiedSummary, getNewAutoImports, getHomeBanners, getMultiYearTrend,
    getReviewScreenData, resolveUnclassifiedCategory, resolveEventReview,
    getMonthlyCategorySummary, getSubcategorySummary, getYearlyTrendFixed, getHomeMonthOverview, getHomeYearOverview,
    // recurring
    listRecurringExpenses, getRecurringScreenInitialData, saveRecurringExpense, deactivateRecurringExpense, removeRecurringExpense,
    listRecurringExpenseGroups, saveRecurringExpenseGroup, getCurrentSettlementRatioForGroup, removeRecurringExpenseGroup,
    resyncRecurringExpense, resyncRecurringExpenseGroup,
    // history / table
    listRecentTransactions, saveTransactionEdit, deleteTransactionById, listTransactionsForYear, listAllTransactionsForExport, updateTransactionField,
    // liff form
    submitTransactionFromLiff,
    // shopping list
    getShoppingScreenData, addShoppingItemFromLiff, toggleShoppingItemPurchased, removeShoppingItem,
    // recipes
    fetchRecipes, fetchRecipeDetail, saveRecipe, deleteRecipe, extractRecipeFromInput, addRecipeIngredientsToShoppingList,
    // asset management
    getAssetScreenInitialData, saveAssetItem, deactivateAssetItem, saveAssetSnapshot, fetchAssetItems,
    saveAssetTermConditions, removeAssetTermConditions,
    getLoanDetailScreenData, saveLoanRateChange, removeLoanRateChange,
    saveAssetGoal, removeAssetGoal,
    // usage monitoring
    getUsageMonitoringData
  };
})();
