-- 008_reference: reference data every installation needs: roles, permissions, cost centres,
-- and a starting chart of accounts (finance can extend it; codes are stable).

insert into roles(code, name, description) values
  ('owner',        'Owner / Director', 'Sees everything; approves overrides'),
  ('finance',      'Finance',          'Bank facilities, guarantees, financing'),
  ('procurement',  'Procurement',      'Suppliers and company orders'),
  ('sales',        'Sales rep',        'Own customers and OGs only'),
  ('distribution', 'Distribution',     'Goods receipt, dispatch, transfers; no prices'),
  ('accounts',     'Accounts',         'Receipts, payments, ledgers, day close'),
  ('auditor',      'Auditor',          'Read-only'),
  ('admin',        'Admin',            'Users and settings; no financial entries');

insert into permissions(code, description) values
  ('dashboard.read',      'View the owner dashboard'),
  ('money.read',          'See prices, amounts and balances'),
  ('masters.read',        'View parties, products, branches, accounts'),
  ('masters.write',       'Create and edit parties, products, branches, accounts'),
  ('ledger.read',         'View journals, ledgers and trial balance'),
  ('journal.create',      'Create manual journal entries'),
  ('journal.approve',     'Approve manual journal entries'),
  ('reversal.request',    'Request a reversal'),
  ('reversal.approve',    'Approve a reversal'),
  ('og.read',             'View all OGs'),
  ('og.read.own',         'View own customers'' OGs'),
  ('og.create',           'Create and submit OGs'),
  ('og.approve',          'Approve or reject OGs'),
  ('og.cancel',           'Cancel OGs'),
  ('dispatch.create',     'Dispatch goods against OGs'),
  ('stock.read',          'View stock'),
  ('stock.receive',       'Record goods received'),
  ('stock.transfer',      'Send and receive stock transfers'),
  ('stock.adjust.request','Request stock adjustments'),
  ('stock.adjust.approve','Approve stock adjustments'),
  ('receipt.read',        'View receipts'),
  ('receipt.create',      'Record receipts and allocate them'),
  ('cheque.return',       'Record returned cheques'),
  ('day.close',           'Close and lock a business day'),
  ('daybook.export',      'Download the day book'),
  ('users.manage',        'Create users, set roles, reset access'),
  ('audit.read',          'View the audit log');

insert into role_permissions(role_code, permission_code)
  select 'owner', code from permissions;

insert into role_permissions(role_code, permission_code)
  select r, p from (values
    ('accounts','dashboard.read'),('accounts','money.read'),('accounts','masters.read'),('accounts','masters.write'),
    ('accounts','ledger.read'),('accounts','journal.create'),('accounts','reversal.request'),('accounts','og.read'),
    ('accounts','receipt.read'),('accounts','receipt.create'),('accounts','cheque.return'),('accounts','day.close'),
    ('accounts','daybook.export'),('accounts','stock.read'),
    ('sales','money.read'),('sales','masters.read'),('sales','og.read.own'),('sales','og.create'),
    ('sales','stock.read'),('sales','receipt.read'),
    ('distribution','masters.read'),('distribution','og.read'),('distribution','dispatch.create'),
    ('distribution','stock.read'),('distribution','stock.receive'),('distribution','stock.transfer'),
    ('distribution','stock.adjust.request'),
    ('procurement','money.read'),('procurement','masters.read'),('procurement','masters.write'),
    ('procurement','stock.read'),('procurement','stock.receive'),
    ('finance','dashboard.read'),('finance','money.read'),('finance','masters.read'),('finance','ledger.read'),
    ('finance','journal.create'),('finance','reversal.request'),('finance','stock.read'),('finance','receipt.read'),
    ('auditor','dashboard.read'),('auditor','money.read'),('auditor','masters.read'),('auditor','ledger.read'),
    ('auditor','og.read'),('auditor','receipt.read'),('auditor','stock.read'),('auditor','audit.read'),
    ('auditor','daybook.export'),
    ('admin','masters.read'),('admin','masters.write'),('admin','users.manage'),('admin','audit.read')
  ) as t(r, p);

insert into cost_centres(code, name) values
  ('BUSINESS', 'Fertilizer business'),
  ('RENTAL',   'Rental'),
  ('PERSONAL', 'Owners'' personal');

-- Chart of accounts. Headers are not postable; leaves are.
insert into accounts(code, name, type, postable) values
  ('1000','Assets','asset',false),
  ('2000','Liabilities','liability',false),
  ('3000','Equity','equity',false),
  ('4000','Income','income',false),
  ('5000','Expenses','expense',false);

insert into accounts(code, name, type, parent_id, postable, control)
select v.code, v.name, v.type, (select id from accounts where code = v.parent), v.postable, v.control
from (values
  ('1100','Cash in hand','asset','1000',false,null),
  ('1101','Main cash','asset','1100',true,'cash'),
  ('1200','Bank accounts','asset','1000',false,null),
  ('1300','Trade receivables','asset','1000',true,'receivable'),
  ('1400','Stock in trade','asset','1000',true,null),
  ('1500','Advances to suppliers','asset','1000',true,'payable'),
  ('1600','Margin money with banks','asset','1000',true,null),
  ('1700','Claims receivable from companies','asset','1000',true,null),
  ('1800','Cheques in hand','asset','1000',true,null),
  ('2100','Trade payables','liability','2000',true,'payable'),
  ('2200','Bank borrowings','liability','2000',false,null),
  ('2300','Taxes payable','liability','2000',true,null),
  ('2400','Accrued expenses','liability','2000',true,null),
  ('3100','Owners'' capital','equity','3000',true,null),
  ('3200','Owners'' drawings','equity','3000',true,null),
  ('3300','Opening balance equity','equity','3000',true,null),
  ('4100','Sales','income','4000',true,null),
  ('4200','Freight recovered','income','4000',true,null),
  ('4300','Rental income','income','4000',true,null),
  ('4900','Other income','income','4000',true,null),
  ('5100','Cost of sales','expense','5000',true,null),
  ('5200','Freight and loading','expense','5000',true,null),
  ('5300','Bank charges and markup','expense','5000',true,null),
  ('5400','Salaries and wages','expense','5000',true,null),
  ('5500','Office and utilities','expense','5000',true,null),
  ('5600','Discounts allowed','expense','5000',true,null),
  ('5900','Other expenses','expense','5000',true,null),
  ('9999','Cash book import suspense','asset',null,true,null)
) as v(code, name, type, parent, postable, control);
