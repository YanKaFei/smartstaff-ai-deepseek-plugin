import { openDatabase } from '../src/db/index.js';
import { all, get, run } from '../src/lib/db.js';
import { id } from '../src/lib/ids.js';

const h = openDatabase('./data/smartstaff.db');
try {
  let orgs = 0, members = 0;
  for (const store of all<{ id: string; name: string; owner_user_id: string | null; organization_id: string | null }>(h.db, 'SELECT id, name, owner_user_id, organization_id FROM stores')) {
    let orgId = store.organization_id;
    if (!orgId) {
      orgId = id('org');
      run(h.db, 'INSERT INTO organizations(id, name, slug, plan, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', [orgId, store.name, `migrated-${orgId.slice(-8)}`, 'starter', 'active', Date.now(), Date.now()]);
      run(h.db, 'UPDATE stores SET organization_id = ? WHERE id = ?', [orgId, store.id]);
      orgs += 1;
    }
    if (store.owner_user_id && !get(h.db, 'SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?', [orgId, store.owner_user_id])) {
      run(h.db, 'INSERT INTO memberships(id, organization_id, user_id, role, store_id, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', [id('mem'), orgId, store.owner_user_id, 'owner', store.id, 'active', Date.now(), Date.now()]);
      members += 1;
    }
    for (const u of all<{ id: string }>(h.db, "SELECT DISTINCT u.id FROM users u JOIN staff_profiles p ON p.user_id = u.id WHERE p.store_id = ? AND u.role = 'staff'", [store.id])) {
      if (!get(h.db, 'SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?', [orgId, u.id])) {
        run(h.db, 'INSERT INTO memberships(id, organization_id, user_id, role, store_id, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', [id('mem'), orgId, u.id, 'staff', store.id, 'active', Date.now(), Date.now()]);
        members += 1;
      }
    }
  }
  console.log(JSON.stringify({ ok: true, organizationsCreated: orgs, membershipsCreated: members }, null, 2));
} finally { h.close(); }
