/**
 * Create-group controls are disabled until the MLS client is ready (BACKLOG
 * create-group-enabled-before-client-ready).
 *
 * MarmotContext.createGroup returns null while the client is not initialised,
 * which the modal surfaced as a generic create-group error. Both the page's
 * Create button and the modal's submit now gate on MarmotContext `ready`.
 * Source assertions: this repo has no jsdom to render the page (convention),
 * and the behaviour is covered end-to-end by the groups-create e2e specs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(APP_ROOT, ...p), 'utf8');

describe('create group before the client is ready', () => {
  it('the groups page Create button is disabled until ready', () => {
    const src = read('pages', 'groups.tsx');
    expect(src).toMatch(
      /<Button\s+onClick=\{createDisclosure\.onOpen\}\s+isDisabled=\{!ready\}\s+data-testid="create-group-btn"/,
    );
  });

  it('the modal submit is disabled until ready', () => {
    const src = read('src', 'components', 'groups', 'CreateGroupModal.tsx');
    expect(src).toMatch(/const \{ createGroup, ready \} = useMarmot\(\);/);
    expect(src).toMatch(/isDisabled=\{!name\.trim\(\) \|\| !ready\}/);
  });
});
