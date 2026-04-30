import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { coaches, ceos, cycles, rawInputs, ceoEmailAliases } from '../src/db/schema';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  const coachList = await db.select().from(coaches);
  console.log('COACHES:');
  for (const c of coachList) {
    console.log(`  ${c.name} <${c.email}> zoom=${c.zoomUserEmail ?? '-'} super=${c.isSuperAdmin}`);
  }

  const ceoList = await db.select().from(ceos);
  console.log(`\nCEOS (${ceoList.length}):`);
  for (const c of ceoList) {
    console.log(`  ${c.name} <${c.email ?? '-'}> coach=${c.coachId?.slice(0, 8) ?? 'unassigned'}`);
  }

  const aliasList = await db.select().from(ceoEmailAliases);
  console.log(`\nALIASES (${aliasList.length}):`);
  for (const a of aliasList) {
    console.log(`  ${a.email} → ${a.ceoId.slice(0, 8)}`);
  }

  const cycleList = await db.select().from(cycles);
  console.log(`\nCYCLES (${cycleList.length}):`);
  for (const cy of cycleList.slice(0, 20)) {
    console.log(`  ${cy.label} (${cy.periodStart} → ${cy.periodEnd}) ceo=${cy.ceoId.slice(0, 8)}`);
  }

  const raw = await db.select().from(rawInputs);
  const byStatus = raw.reduce((acc, r) => {
    acc[r.matchStatus] = (acc[r.matchStatus] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const bySource = raw.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`\nRAW_INPUTS (${raw.length} total):`);
  console.log('  by status:', byStatus);
  console.log('  by source:', bySource);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
