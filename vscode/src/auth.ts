import * as vscode from 'vscode';
import { basicAuthHeader, bearerAuthHeader, hostOf } from './core/git';
import { PluginSource } from './core/types';

const AZDO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'; // Azure DevOps

/** Resolves HTTP credentials for a source: a stored token, or VS Code's built-in GitHub / Microsoft accounts. */
export class AuthProvider {
  constructor(private readonly secrets: vscode.SecretStorage) { }

  private key(id: string): string {
    return 'agentPluginManager.pat.' + id;
  }

  getToken(id: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(this.key(id)));
  }

  async setToken(id: string, token: string | undefined): Promise<void> {
    if (token) {
      await this.secrets.store(this.key(id), token);
    } else {
      await this.secrets.delete(this.key(id));
    }
  }

  async authHeader(source: PluginSource, interactive: boolean): Promise<string | undefined> {
    if (source.kind !== 'git') {
      return undefined;
    }
    if (source.auth === 'pat') {
      const token = await this.getToken(source.id);
      return token ? basicAuthHeader(source.location, token) : undefined;
    }
    if (source.auth === 'vscode') {
      return this.fromVsCodeAccount(source, interactive);
    }
    return undefined;
  }

  private async fromVsCodeAccount(source: PluginSource, interactive: boolean): Promise<string | undefined> {
    const host = hostOf(source.location);
    // createIfNone shows the sign-in flow; silent only reuses an existing session (used for background updates).
    const options: vscode.AuthenticationGetSessionOptions = interactive ? { createIfNone: true } : { silent: true };

    if (host === 'github.com') {
      const s = await vscode.authentication.getSession('github', ['repo'], options);
      return s ? basicAuthHeader(source.location, s.accessToken) : undefined;
    }
    if (host.endsWith('dev.azure.com') || host.endsWith('.visualstudio.com')) {
      const s = await vscode.authentication.getSession('microsoft', [AZDO_SCOPE], options);
      return s ? bearerAuthHeader(s.accessToken) : undefined;
    }
    throw new Error("'Sign in with VS Code' supports github.com and Azure DevOps. Use 'Single sign-on' or a personal access token for " + (host || 'this host') + '.');
  }
}
