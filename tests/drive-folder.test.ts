import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FOLDER_MIME,
  fakeDrive,
  type FakeDrive,
  type FakeGoogleDrive,
  type FakeItem,
} from './drive.js';

/**
 * `google.drive-folder` through `testPlugin`: planned over an input table by `runRecipe` and
 * applied as the notebook's Apply does, over a synthetic Drive, signed in as a synthetic
 * person. Every id, name and email is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

const ROOT_ID = 'root0123456789';
const CLIENTS_ID = 'clients0123456';
const OTHER_ID = 'other0123456789';
const PERSON_TOKEN = 'person-token-0123';
const VERB = 'google.drive-folder';

let open: FakeGoogleDrive | undefined;
async function google(
  drive: FakeDrive,
  options: { readonly signedIn?: boolean; readonly section?: unknown } = {},
): Promise<FakeGoogleDrive> {
  await open?.plugin.close();
  open = await fakeDrive(drive, {
    section: options.section ?? { root: ROOT_ID },
    signins: options.signedIn === false ? {} : { google: PERSON_TOKEN },
  });
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const folder = (id: string, name: string, parents: string[]): FakeItem => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  parents,
  createdTime: '2026-11-01T09:00:00.000Z',
});

/** The root with a `Clients` folder in it, and a folder outside it. */
function studio(extra: FakeItem[] = []): FakeDrive {
  return {
    items: [
      folder(ROOT_ID, 'Studio', ['top0123456789x']),
      folder(CLIENTS_ID, 'Clients', [ROOT_ID]),
      folder(OTHER_ID, 'Elsewhere', []),
      ...extra,
    ],
    ids: ['newA0123456789', 'newB0123456789', 'newC0123456789'],
  };
}

function table(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): InputTable {
  return {
    columns: columns.map((name) => ({ name, type: 'text', origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: `r${index + 1}`,
      values: Object.fromEntries(columns.map((name, at) => [name, cells[at] ?? null])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-11T00:00:00.000Z' },
    })),
  };
}

async function plan(drive: FakeGoogleDrive, step: string, input: InputTable) {
  const ran = await drive.plugin.runRecipe(step, { input });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  return {
    plan: cell?.plan,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

type Planned = NonNullable<Awaited<ReturnType<typeof plan>>['plan']>;

async function apply(drive: FakeGoogleDrive, planned: Planned) {
  const verb = drive.plugin.recipes.verbs.get(VERB);
  if (verb?.apply === undefined) throw new Error(`${VERB} has no apply`);
  const applied = await verb.apply(planned);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  return applied.value.operations.map(({ status, reason }) => ({
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
}

const item = (drive: FakeGoogleDrive, id: string): FakeItem | undefined =>
  drive.drive.items.find((each) => each.id === id);
const posts = (drive: FakeGoogleDrive) => drive.calls.filter((call) => call.method === 'POST');

describe('google.drive-folder', () => {
  it('creates each row as the signed-in person and shares it with the people listed', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      `${VERB} share=Share`,
      table(
        ['name', 'Share'],
        [
          ['Acme', 'ana@example.com:writer; bo@example.com:reader'],
          ['Globex', null],
        ],
      ),
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.plan?.target).toBe(`Drive folder 'Studio' (${ROOT_ID})`);
    expect(
      answer.plan?.operations.map((each) => [each.write, each.rowKey, each.description]),
    ).toEqual([
      [
        'create',
        'r1',
        `create folder "Acme" in 'Studio' (${ROOT_ID}), at https://drive.google.com/drive/folders/newA0123456789`,
      ],
      ['share', 'r1', 'share "Acme" with ana@example.com as writer'],
      ['share', 'r1', 'share "Acme" with bo@example.com as reader'],
      [
        'create',
        'r2',
        `create folder "Globex" in 'Studio' (${ROOT_ID}), at https://drive.google.com/drive/folders/newB0123456789`,
      ],
    ]);
    expect(answer.plan?.operations[1]?.payload).toEqual({
      s: 'newA0123456789',
      n: 'Acme',
      e: 'ana@example.com',
      r: 'writer',
      notify: false,
    });
    // The search a second run relies on, and the ids asked for once, both as the person.
    expect(drive.calls.find((call) => call.query['q']?.startsWith('name ='))?.query['q']).toBe(
      `name = 'Acme' and '${ROOT_ID}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    expect(
      drive.calls.filter((call) => call.path.endsWith('/generateIds')).map((call) => call.query),
    ).toEqual([{ count: '2', space: 'drive', type: 'files' }]);
    expect(posts(drive)).toEqual([]);

    expect(await apply(drive, answer.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(posts(drive)[0]?.body).toEqual({
      id: 'newA0123456789',
      name: 'Acme',
      mimeType: FOLDER_MIME,
      parents: [ROOT_ID],
    });
    expect(item(drive, 'newA0123456789')?.parents).toEqual([ROOT_ID]);
    expect(item(drive, 'newA0123456789')?.permissions).toEqual([
      { email: 'ana@example.com', role: 'writer', notified: false },
      { email: 'bo@example.com', role: 'reader', notified: false },
    ]);
    expect(item(drive, 'newB0123456789')?.permissions).toBeUndefined();
    // Every Drive request, the plan's and the Apply's, was the person's; the service account
    // was never asked for a token and is shared nothing.
    expect(new Set(drive.calls.map((call) => call.authorization))).toEqual(
      new Set([`Bearer ${PERSON_TOKEN}`]),
    );
    expect(JSON.stringify(answer.plan)).not.toContain(PERSON_TOKEN);
  });

  it('plans no share for a row whose share column is empty', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      `${VERB} share=Share`,
      table(['name', 'Share'], [['Acme', ' ']]),
    );
    expect(answer.plan?.operations.map((each) => each.write)).toEqual(['create']);
  });

  it('emails the people only with notify=yes', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      `${VERB} share=Share notify=yes`,
      table(['name', 'Share'], [['Acme', 'ana@example.com:commenter']]),
    );
    expect(answer.plan?.operations[1]?.description).toBe(
      'share "Acme" with ana@example.com as commenter, emailing them',
    );
    await apply(drive, answer.plan!);
    const share = posts(drive).find((call) => call.path.endsWith('/permissions'));
    expect(share?.query).toEqual({
      sendNotificationEmail: 'true',
      supportsAllDrives: 'true',
      fields: 'id',
    });
    expect(share?.body).toEqual({
      type: 'user',
      role: 'commenter',
      emailAddress: 'ana@example.com',
    });
  });

  it('creates nothing twice: a second run finds the first run’s folder and warns', async () => {
    const drive = await google(studio());
    const input = table(['name'], [['Acme']]);
    const first = await plan(drive, VERB, input);
    await apply(drive, first.plan!);
    const second = await plan(drive, VERB, input);
    expect(second.plan?.operations).toEqual([]);
    expect(second.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: `'${VERB}' plans nothing for 'Acme': already in 'Studio' (${ROOT_ID}).`,
      },
    ]);
    expect(drive.drive.items.filter((each) => each.name === 'Acme')).toHaveLength(1);
  });

  it('fails the second of two rows of one name, and stops on two existing folders', async () => {
    const drive = await google(studio());
    const twice = await plan(drive, VERB, table(['name'], [['Acme'], ['Acme']]));
    expect(twice.plan?.operations.map((each) => [each.write, each.payload])).toEqual([
      ['create', { c: 'newA0123456789', n: 'Acme', p: ROOT_ID, m: FOLDER_MIME }],
      ['create', { x: "E_GOOGLE_PLAN: r2: 'Acme' is the name of row r1 too" }],
    ]);

    const crowded = await google(
      studio([
        folder('acme1012345678', 'Acme', [ROOT_ID]),
        folder('acme2012345678', 'Acme', [ROOT_ID]),
      ]),
    );
    const ran = await crowded.plugin.runRecipe(VERB, { input: table(['name'], [['Acme']]) });
    expect(JSON.stringify(ran)).toContain("finds 2 items named 'Acme' in 'Studio'");
    expect(posts(crowded)).toEqual([]);
  });

  it('creates under parent=, a folder under the root, and refuses one outside it', async () => {
    const drive = await google(studio());
    const named = await plan(drive, `${VERB} parent=Clients`, table(['name'], [['Acme']]));
    expect(named.plan?.target).toBe(`Drive folder 'Clients' (${CLIENTS_ID})`);
    expect(named.plan?.operations[0]?.payload).toMatchObject({ p: CLIENTS_ID });

    const outside = await drive.plugin.runRecipe(`${VERB} parent=${OTHER_ID}`, {
      input: table(['name'], [['Acme']]),
    });
    expect(JSON.stringify(outside)).toContain(
      "parent= names 'Elsewhere', which is not under the root folder root0123456789",
    );
    const missing = await drive.plugin.runRecipe(`${VERB} parent=Archive`, {
      input: table(['name'], [['Acme']]),
    });
    expect(JSON.stringify(missing)).toContain(
      "parent= names 'Archive', which is neither a folder directly in the root folder",
    );
    expect(posts(drive)).toEqual([]);
  });

  it('fails a row whose name is blank or whose share cell is not email:role', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      `${VERB} share=Share`,
      table(
        ['name', 'Share'],
        [
          ['', null],
          ['Acme', 'ana@example.com:owner'],
          ['Globex', 'nobody:writer'],
        ],
      ),
    );
    expect(answer.plan?.operations.map((each) => each.payload)).toEqual([
      { x: 'E_GOOGLE_PLAN: r1: name holds no name' },
      {
        x: "E_GOOGLE_PLAN: r2: Share gives ana@example.com the role 'owner'; a role is reader, commenter, writer",
      },
      { x: "E_GOOGLE_PLAN: r3: Share holds 'nobody:writer', which does not start with an email" },
    ]);
    expect(drive.calls.some((call) => call.path.endsWith('/generateIds'))).toBe(false);
  });

  it('fails the shares of a create Drive refused, and redacts the token it echoed', async () => {
    const drive = await google({ ...studio(), refusedNames: ['Acme'] });
    const answer = await plan(
      drive,
      `${VERB} share=Share`,
      table(
        ['name', 'Share'],
        [
          ['Acme', 'ana@example.com:writer'],
          ['Globex', 'ana@example.com:writer'],
        ],
      ),
    );
    const applied = await apply(drive, answer.plan!);
    expect(applied.map((each) => each.status)).toEqual(['failed', 'failed', 'applied', 'applied']);
    expect(applied[0]?.reason).toContain('E_GOOGLE_AUTH');
    expect(applied[0]?.reason).toContain('[redacted]');
    expect(applied[1]?.reason).toContain("creating 'Acme' failed, so it is not shared:");
    expect(JSON.stringify(applied)).not.toContain(PERSON_TOKEN);
    expect(
      posts(drive).filter((call) => call.path === '/drive/v3/files/newA0123456789/permissions'),
    ).toEqual([]);
  });

  it('fails only the share a domain refuses', async () => {
    const drive = await google({ ...studio(), refusedDomain: 'elsewhere.example' });
    const answer = await plan(
      drive,
      `${VERB} share=Share`,
      table(['name', 'Share'], [['Acme', 'ana@elsewhere.example:reader; bo@example.com:reader']]),
    );
    const applied = await apply(drive, answer.plan!);
    expect(applied.map((each) => each.status)).toEqual(['applied', 'failed', 'applied']);
    expect(applied[1]?.reason).toContain('ACL change not allowed');
    expect(item(drive, 'newA0123456789')?.permissions).toEqual([
      { email: 'bo@example.com', role: 'reader', notified: false },
    ]);
  });

  it('counts a create already made as applied, found by its name or by its id', async () => {
    const drive = await google(studio());
    const answer = await plan(drive, VERB, table(['name'], [['Acme'], ['Globex']]));
    expect(await apply(drive, answer.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    // Applied again: found by its name, with no second create.
    expect(await apply(drive, answer.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(posts(drive)).toHaveLength(2);

    // Renamed since: the search misses it, Drive answers 409 for the id, and the id tells.
    const renamed = item(drive, 'newB0123456789');
    if (renamed !== undefined) renamed.name = 'Globex (old)';
    expect(await apply(drive, answer.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(posts(drive)).toHaveLength(3);
  });

  it('fails a create when another folder of its name appeared since the plan', async () => {
    const drive = await google(studio());
    const answer = await plan(drive, VERB, table(['name'], [['Acme']]));
    drive.drive.items.push(folder('acme9012345678', 'Acme', [ROOT_ID]));
    const applied = await apply(drive, answer.plan!);
    expect(applied[0]?.reason).toContain("E_GOOGLE_CHANGED: 'Acme' was created in");
    expect(posts(drive)).toEqual([]);
  });

  it('says to sign in when nobody is, at the plan and at Apply', async () => {
    const signedOut = await google(studio(), { signedIn: false });
    const ran = await signedOut.plugin.runRecipe(VERB, { input: table(['name'], [['Acme']]) });
    expect(JSON.stringify(ran)).toContain('E_GOOGLE_SIGNIN');
    expect(signedOut.calls).toEqual([]);

    const drive = await google(studio());
    const answer = await plan(drive, VERB, table(['name'], [['Acme']]));
    expect(drive.plugin.signOut('google')).toBe(true);
    const applied = await apply(drive, answer.plan!);
    expect(applied[0]?.status).toBe('failed');
    expect(applied[0]?.reason).toContain('E_GOOGLE_SIGNIN');
    expect(posts(drive)).toEqual([]);
  });
});
