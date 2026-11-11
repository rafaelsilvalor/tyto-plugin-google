import { readFileSync } from 'node:fs';

import { PLUGIN_API_VERSION, createPluginHost, type Disposable } from '@tyto/plugin-api';
import { testPlugin } from '@tyto/plugin-api/testing';
import { describe, expect, it } from 'vitest';

import { activate } from '../src/index.js';

/**
 * The plugin as Tyto loads it: the manifest's text checked by install against the
 * `@tyto/plugin-api` this repository installed, and the committed `dist/index.js` — the file
 * Tyto copies and never builds — activated over the isolation protocol (Tyto ADR 0150).
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;
const load = (): Promise<unknown> => import(entry);

async function harness(signins: Readonly<Record<string, string>> = {}) {
  const loaded = await testPlugin({ manifest, load, signins });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return loaded.value;
}

describe('tyto-plugin.json', () => {
  it(`is a plugin the installed plugin API (${PLUGIN_API_VERSION}) installs and activates`, async () => {
    const loaded = await testPlugin({ manifest, load });
    expect(loaded.ok ? [] : loaded.error.map((item) => `${item.code}: ${item.message}`)).toEqual(
      [],
    );
    if (loaded.ok) await loaded.value.close();
  });

  it('reaches only the three Google API hosts, and holds the service account and a sign-in', async () => {
    const plugin = await harness();
    expect(plugin.manifest.name).toBe('google');
    expect(plugin.manifest.namespace).toBe('google');
    // No setting: the configuration is the project's `google` section, handed to every call.
    expect(plugin.manifest.contributes).toEqual(['recipe-verb']);
    expect(plugin.manifest.permissions).toEqual([
      'net:oauth2.googleapis.com',
      'net:sheets.googleapis.com',
      'net:www.googleapis.com',
      'credentials:service-account',
      'signin:google',
    ]);
    await plugin.close();
  });

  it('declares the Google sign-in with no client, which the person supplies (Tyto ADR 0192)', async () => {
    const plugin = await harness({ google: 'person-token' });
    expect(plugin.manifest.engine).toBe('>=0.20');
    expect(plugin.manifest.signin).toEqual({
      google: {
        authorize:
          'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
        token: 'https://oauth2.googleapis.com/token',
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive'],
      },
    });
    // Read from the text too: an organisation's client never enters this public repository.
    expect(manifest).not.toMatch(/client(Id|Secret)/u);
    expect(plugin.signOut('google')).toBe(true);
    expect(plugin.signOut('google')).toBe(false);
    await plugin.close();
  });

  it('declares only the kinds of write a verb of this version plans', async () => {
    const plugin = await harness();
    expect(plugin.manifest.writes).toEqual([
      'clear',
      'write-row',
      'add-tab',
      'update',
      'move',
      'delete',
      'add',
      'format-tab',
    ]);
    // `move` is both a sync's (a row to another tab) and `google.drive-move`'s.
    const declared = [
      ...new Set(plugin.host.registry.recipeVerbs().flatMap((verb) => verb.writes ?? [])),
    ].sort();
    expect(declared).toEqual([...(plugin.manifest.writes ?? [])].sort());
    await plugin.close();
  });

  it('carries the version package.json carries', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const plugin = await harness();
    expect(plugin.manifest.version).toBe(packageJson.version);
    await plugin.close();
  });
});

describe('activate', () => {
  it('registers no setting, the three sources, the two sheet sinks, the action and the transforms', async () => {
    const plugin = await harness();
    expect(plugin.host.registry.configurations()).toEqual([]);
    expect(plugin.host.registry.recipeVerbs().map((verb) => `${verb.id}:${verb.kind}`)).toEqual([
      'google.sheet-rows:source',
      'google.sheet-write:sink',
      'google.sheet-sync:sink',
      'google.drive-list:source',
      'google.drive-read:source',
      'google.drive-move:action',
      'google.drive-count:transform',
      'google.sheet-lookup:transform',
    ]);
    await plugin.close();
  });

  it('withdraws everything it registered when disposed', () => {
    const host = createPluginHost();
    let registered: Disposable | undefined;
    const activated = host.tryActivate({
      id: 'google',
      manifest: JSON.parse(manifest) as unknown,
      activate(pluginHost) {
        registered = activate(pluginHost);
        return registered;
      },
    });
    expect(activated.ok).toBe(true);
    registered?.dispose();
    expect(host.registry.configurations()).toEqual([]);
    expect(host.registry.recipeVerbs()).toEqual([]);
  });
});
