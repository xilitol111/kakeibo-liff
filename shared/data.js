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
    return unwrap(await sb().from('transactions').select('id,occurred_at').eq('category', '未分類').order('occurred_at', { ascending: true }));
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

  async function getBudgetsForMonth(yearMonth) {
    const [budgetRows, actualRows, ratioRows] = await Promise.all([
      fetchBudgets(yearMonth),
      sb().from('transactions').select('category,amount,is_reimbursement').gte('occurred_at', yearMonth).lt('occurred_at', nextYearMonth_(yearMonth)).is('event_tag', null).then(unwrap),
      sb().from('settlement_ratios').select('*').lte('effective_from', yearMonth).order('effective_from', { ascending: false }).limit(1).then(unwrap)
    ]);
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
    const [categoryRows, budgetRows, ratioRows] = await Promise.all([
      sb().from('transactions').select('occurred_at,category,amount,is_reimbursement').gte('occurred_at', `${year}-01-01`).lt('occurred_at', `${Number(year) + 1}-01-01`).is('event_tag', null).then(unwrap),
      sb().from('budgets').select('*').gte('year_month', `${year}-01-01`).lte('year_month', `${year}-12-01`).then(unwrap),
      sb().from('settlement_ratios').select('*').lte('effective_from', `${year}-01-01`).order('effective_from', { ascending: false }).limit(1).then(unwrap)
    ]);
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
      return { id: e.id, name: e.name, budget: e.budget_amount, actual, pct: (e.budget_amount != null && e.budget_amount > 0) ? Math.round((actual / e.budget_amount) * 100) : null };
    });
  }
  async function listEventNames() { return (await fetchAllEvents()).map((e) => e.name); }
  async function listEventsWithActuals() {
    const events = await fetchAllEvents();
    if (events.length === 0) return [];
    return buildEventsWithActuals_(events, await fetchEventActuals());
  }
  async function saveEvent(payload) {
    if (!payload.name) throw new Error('イベント名を入力してください。');
    const record = { name: payload.name, budget_amount: isFilled_(payload.budgetAmount) ? Number(payload.budgetAmount) : null };
    return payload.id ? updateEvent(payload.id, record) : insertEvent(record);
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
  async function getNewAutoImports(sinceTimestamp) {
    const rows = await fetchAutoImportsSince(sinceTimestamp);
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    return { count: rows.length, total, items: rows.slice(0, 8), latestCreatedAt: rows.length > 0 ? rows[0].created_at : sinceTimestamp };
  }
  async function getHomeBanners(sinceTimestamp) {
    const today = todayStr();
    const prevMonthYm = previousMonthKey_(today);
    const dayOfMonth = Number(today.slice(8, 10));
    const [unclassifiedRows, autoImportRows, prevSettlementRows, prevConfirmationRows] = await Promise.all([
      fetchUnclassifiedTransactions(), fetchAutoImportsSince(sinceTimestamp),
      sb().from('settlement_summary').select('*').eq('year_month', prevMonthYm).then(unwrap),
      sb().from('settlement_confirmations').select('*').eq('year_month', prevMonthYm).then(unwrap)
    ]);
    const unclassified = { count: unclassifiedRows.length, earliestYear: unclassifiedRows.length > 0 ? Number(unclassifiedRows[0].occurred_at.slice(0, 4)) : null };
    const autoImportTotal = autoImportRows.reduce((sum, r) => sum + Number(r.amount), 0);
    const autoImports = { count: autoImportRows.length, total: autoImportTotal, items: autoImportRows.slice(0, 8), latestCreatedAt: autoImportRows.length > 0 ? autoImportRows[0].created_at : sinceTimestamp };
    const prevHadSpending = prevSettlementRows.length > 0 && prevSettlementRows[0].total_shared_amount > 0;
    const prevConfirmed = prevConfirmationRows.length > 0;
    const unconfirmedSettlement = (prevHadSpending && !prevConfirmed && dayOfMonth >= 5) ? { yearMonth: prevMonthYm, totalSharedAmount: prevSettlementRows[0].total_shared_amount } : null;
    return { unclassified, autoImports, unconfirmedSettlement };
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
    getShoppingScreenData, addShoppingItemFromLiff, toggleShoppingItemPurchased, removeShoppingItem
  };
})();
