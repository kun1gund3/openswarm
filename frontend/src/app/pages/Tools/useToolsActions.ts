import React, { useCallback, useRef, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  createTool,
  updateTool,
  deleteTool,
  startOAuth,
  fetchToolStatus,
  discoverTools,
  startDeviceCodeLogin,
  pollDeviceCodeStatus,
  disconnectM365,
  updateBuiltinPermissions,
  ToolDefinition,
  BuiltinTool,
} from '@/shared/state/toolsSlice';
import {
  searchRegistry,
  fetchRegistryStats,
  McpServer,
} from '@/shared/state/mcpRegistrySlice';
import { API_BASE } from '@/shared/config';
import { Integration } from './integrations';
import { ToolForm, emptyForm, serverToToolForm, serverToMcpConfig } from './toolsHelpers';

type Snackbar = { open: boolean; message: string; severity?: 'success' | 'error' };
type RegSource = '' | 'community' | 'google' | 'curated';

interface ToolsActionsDeps {
  items: Record<string, ToolDefinition>;
  allTools: ToolDefinition[];
  regServersRaw: McpServer[];
  closeMenu: () => void;
}

export function useToolsActions({ items, allTools, regServersRaw, closeMenu }: ToolsActionsDeps) {
  const dispatch = useAppDispatch();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolForm>(emptyForm);

  const [registryOpen, setRegistryOpen] = useState(false);
  const [regQuery, setRegQuery] = useState('');
  const [regSort, setRegSort] = useState<'name' | 'stars'>('stars');
  // Default 'curated' hides the long tail; client-side filter, backend still returns the full list.
  const [regSource, setRegSource] = useState<RegSource>('curated');
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<Snackbar>({ open: false, message: '' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const [mcpConfigServer, setMcpConfigServer] = useState<McpServer | null>(null);
  const [mcpAuthType, setMcpAuthType] = useState<'none' | 'env_vars'>('none');
  const [mcpCredentials, setMcpCredentials] = useState<Record<string, string>>({});
  const [mcpConfigJson, setMcpConfigJson] = useState('');
  const [mcpConfigError, setMcpConfigError] = useState('');

  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [integrationLoading, setIntegrationLoading] = useState<Record<string, boolean>>({});
  const [expandedServices, setExpandedServices] = useState<Record<string, boolean>>({});
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);

  const [deviceCodeDialogOpen, setDeviceCodeDialogOpen] = useState(false);
  const [deviceCodeDialogToolId, setDeviceCodeDialogToolId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState('');
  const [deviceCodeUrl, setDeviceCodeUrl] = useState('');
  const [deviceCodeStatus, setDeviceCodeStatus] = useState<'loading' | 'awaiting' | 'connected' | 'error'>('loading');

  const [credDialogOpen, setCredDialogOpen] = useState(false);
  const [credDialogToolId, setCredDialogToolId] = useState<string | null>(null);
  const [credDialogIntegration, setCredDialogIntegration] = useState<Integration | null>(null);
  const [credDialogValues, setCredDialogValues] = useState<Record<string, string>>({});
  const [credDialogSaving, setCredDialogSaving] = useState(false);

  const getInstalledIntegration = (integration: Integration): ToolDefinition | undefined => {
    return allTools.find((t) => t.name === integration.name);
  };

  const handleIntegrationToggle = async (integration: Integration) => {
    const existing = getInstalledIntegration(integration);
    setIntegrationLoading((p) => ({ ...p, [integration.id]: true }));
    try {
      if (existing && existing.enabled !== false) {
        await dispatch(updateTool({ id: existing.id, enabled: false }));
        setSnackbar({ open: true, message: `Disabled ${integration.name}` });
      } else if (existing && existing.enabled === false) {
        await dispatch(updateTool({ id: existing.id, enabled: true }));
        if (integration.authType === 'oauth2' && existing.auth_status !== 'connected') {
          setSnackbar({ open: true, message: `Enabled ${integration.name}, connect your account to discover actions` });
        } else {
          setSnackbar({ open: true, message: `Enabled ${integration.name}, re-discovering actions…` });
          const discoverResult = await dispatch(discoverTools(existing.id));
          if (discoverTools.fulfilled.match(discoverResult)) {
            setSnackbar({ open: true, message: `${integration.name} ready, actions discovered` });
          } else {
            const detail = (discoverResult as any).error?.message || 'discovery failed';
            setSnackbar({ open: true, message: `${integration.name}: ${detail}`, severity: 'error' });
          }
        }
      } else {
        const result = await dispatch(createTool({
          name: integration.name,
          description: integration.description,
          command: '',
          mcp_config: integration.mcp_config,
          credentials: {},
          auth_type: integration.authType || 'none',
          auth_status: 'configured',
        }));
        if (createTool.fulfilled.match(result)) {
          const newTool = result.payload;
          if (integration.authType === 'oauth2' || integration.authType === 'device_code') {
            setSnackbar({ open: true, message: `Enabled ${integration.name}, connect your account to discover actions` });
          } else {
            setSnackbar({ open: true, message: `Enabled ${integration.name}, discovering actions…` });
            const discoverResult = await dispatch(discoverTools(newTool.id));
            if (discoverTools.fulfilled.match(discoverResult)) {
              setSnackbar({ open: true, message: `${integration.name} ready, actions discovered` });
            } else {
              const detail = (discoverResult as any).error?.message
                || `discovery failed; is ${integration.mcp_config.command || 'the server'} installed?`;
              setSnackbar({ open: true, message: `${integration.name}: ${detail}`, severity: 'error' });
            }
          }
        }
      }
    } finally {
      setIntegrationLoading((p) => ({ ...p, [integration.id]: false }));
    }
  };

  const handleDiscover = async (toolId: string) => {
    setDiscovering(true);
    try {
      const result = await dispatch(discoverTools(toolId));
      if (discoverTools.fulfilled.match(result)) {
        setSnackbar({ open: true, message: 'Actions discovered successfully' });
      } else {
        const detail = (result as any).error?.message || 'Discovery failed; is the MCP server running?';
        setSnackbar({ open: true, message: detail, severity: 'error' });
      }
    } finally {
      setDiscovering(false);
    }
  };

  const handlePermissionChange = async (toolId: string, toolName: string, policy: string) => {
    const tool = items[toolId];
    if (!tool) return;
    const updated = { ...tool.tool_permissions, [toolName]: policy };
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleGroupPermissionChange = async (toolId: string, names: string[], policy: string) => {
    const tool = items[toolId];
    if (!tool) return;
    const updated = { ...tool.tool_permissions };
    for (const name of names) updated[name] = policy;
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleBulkReadOnly = async (toolId: string) => {
    const tool = items[toolId];
    if (!tool?.tool_permissions?._categories) return;
    const readNames: string[] = tool.tool_permissions._categories.read || [];
    const updated = { ...tool.tool_permissions };
    for (const name of readNames) updated[name] = 'always_allow';
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleResetPermissions = async (toolId: string) => {
    const tool = items[toolId];
    if (!tool?.tool_permissions) return;
    const updated = { ...tool.tool_permissions };
    for (const key of Object.keys(updated)) {
      if (!key.startsWith('_')) updated[key] = 'ask';
    }
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleBuiltinPermissionChange = async (toolName: string, policy: string) => {
    await dispatch(updateBuiltinPermissions({ [toolName]: policy }));
  };

  const handleBuiltinCategoryPermissionChange = async (toolNames: string[], policy: string) => {
    const perms: Record<string, string> = {};
    for (const name of toolNames) perms[name] = policy;
    await dispatch(updateBuiltinPermissions(perms));
  };

  const handleSectionEnabledChange = async (tools: BuiltinTool[], enabled: boolean) => {
    const perms: Record<string, string> = {};
    for (const t of tools) perms[t.name] = enabled ? 'always_allow' : 'deny';
    await dispatch(updateBuiltinPermissions(perms));
  };

  const openCreate = () => {
    closeMenu();
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openRegistryBrowser = () => {
    closeMenu();
    setRegistryOpen(true);
    setRegQuery('');
    setRegSort('stars');
    setRegSource('');
    setExpandedServer(null);
    dispatch(fetchRegistryStats());
    dispatch(searchRegistry({ q: '', limit: 20, offset: 0, sort: 'stars', source: '' }));
  };

  const openEdit = (tool: ToolDefinition) => {
    setEditingId(tool.id);
    setForm({ name: tool.name, description: tool.description, command: tool.command });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const payload = { name: form.name, description: form.description, command: form.command };
    if (editingId) { await dispatch(updateTool({ id: editingId, ...payload })); } else { await dispatch(createTool(payload)); }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => { await dispatch(deleteTool(id)); };

  // Translate UI "curated" pseudo-source to "" for the backend; the whitelist is applied client-side.
  const _backendSource = (s: RegSource): '' | 'community' | 'google' =>
    s === 'curated' ? '' : s;

  const handleRegSearch = useCallback((q: string, sort?: 'name' | 'stars', source?: RegSource) => {
    setRegQuery(q);
    setExpandedServer(null);
    const sortVal = sort ?? regSort;
    const sourceVal = source ?? regSource;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch(searchRegistry({ q, limit: 20, offset: 0, sort: sortVal, source: _backendSource(sourceVal) }));
    }, 300);
  }, [dispatch, regSort, regSource]);

  const handleLoadMore = () => {
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: regServersRaw.length, sort: regSort, source: _backendSource(regSource) }));
  };

  const handleRegSort = (sort: 'name' | 'stars') => {
    setRegSort(sort);
    setExpandedServer(null);
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort, source: _backendSource(regSource) }));
  };

  const handleRegSourceFilter = (_: React.MouseEvent<HTMLElement>, val: RegSource) => {
    if (val === null) return;
    setRegSource(val);
    setExpandedServer(null);
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort: regSort, source: _backendSource(val) }));
  };

  const openMcpConfigDialog = (srv: McpServer) => {
    setMcpConfigServer(srv);
    setMcpAuthType('none');
    setMcpCredentials({});
    const derivedConfig = serverToMcpConfig(srv);
    setMcpConfigJson(JSON.stringify(
      Object.keys(derivedConfig).length > 0 ? derivedConfig : {},
      null, 2,
    ));
    setMcpConfigError('');
    setMcpConfigOpen(true);
  };

  const handleMcpConfigSave = async () => {
    if (!mcpConfigServer) return;
    let parsedConfig: Record<string, any> = {};
    try { parsedConfig = JSON.parse(mcpConfigJson); } catch { setMcpConfigError('Invalid JSON'); return; }

    const f = serverToToolForm(mcpConfigServer);
    const authStatus = 'configured';

    await dispatch(createTool({
      name: f.name,
      description: f.description,
      command: '',
      mcp_config: parsedConfig,
      credentials: mcpCredentials,
      auth_type: mcpAuthType,
      auth_status: authStatus,
    }));

    setMcpConfigOpen(false);
    setSnackbar({ open: true, message: `Installed "${f.name}" as MCP tool` });
  };

  const handleInstall = async (srv: McpServer) => {
    const f = serverToToolForm(srv);
    const mcpConfig = serverToMcpConfig(srv);
    const hasConfig = Object.keys(mcpConfig).length > 0;

    if (srv.source === 'google' && srv.remoteUrl && hasConfig) {
      await dispatch(createTool({
        name: f.name,
        description: f.description,
        command: '',
        mcp_config: mcpConfig,
        credentials: {},
        auth_type: 'oauth2',
        auth_status: 'configured',
      }));
      setSnackbar({ open: true, message: `Installed "${f.name}", click "Connect Google" to authorize` });
    } else if (hasConfig && mcpConfig.type === 'stdio') {
      const result = await dispatch(createTool({
        name: f.name,
        description: f.description,
        command: '',
        mcp_config: mcpConfig,
        credentials: {},
        auth_type: 'none',
        auth_status: 'configured',
      }));
      if (createTool.fulfilled.match(result)) {
        const newTool = result.payload;
        setSnackbar({ open: true, message: `Installed "${f.name}", discovering actions…` });
        const discoverResult = await dispatch(discoverTools(newTool.id));
        if (discoverTools.fulfilled.match(discoverResult)) {
          setSnackbar({ open: true, message: `${f.name} ready, actions discovered` });
        } else {
          const detail = (discoverResult as any).error?.message
            || 'discovery failed; the MCP server may need setup first';
          setSnackbar({ open: true, message: `${f.name}: ${detail}`, severity: 'error' });
        }
      }
    } else {
      openMcpConfigDialog(srv);
    }
  };

  const handleEditInstall = (srv: McpServer) => {
    setRegistryOpen(false);
    const f = serverToToolForm(srv);
    setEditingId(null);
    setForm(f);
    setDialogOpen(true);
  };

  const handleOAuthConnect = async (toolId: string) => {
    const result = await dispatch(startOAuth(toolId));
    if (startOAuth.fulfilled.match(result)) {
      const { auth_url } = result.payload;
      const popup = window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');

      const afterConnect = async () => {
        const statusResult = await dispatch(fetchToolStatus(toolId));
        if (fetchToolStatus.fulfilled.match(statusResult) && statusResult.payload.auth_status === 'connected') {
          setSnackbar({ open: true, message: 'Account connected! Discovering actions…' });
          setExpandedToolId(toolId);
          dispatch(discoverTools(toolId));
        } else {
          setSnackbar({ open: true, message: 'Account connected!' });
        }
      };

      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_complete' && event.data?.tool_id === toolId) {
          afterConnect();
          window.removeEventListener('message', onMessage);
        }
      };
      window.addEventListener('message', onMessage);

      const pollInterval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollInterval);
          afterConnect();
          window.removeEventListener('message', onMessage);
        }
      }, 1000);
    } else {
      setSnackbar({ open: true, message: 'OAuth failed; check that OAuth credentials are set in backend .env', severity: 'error' });
    }
  };

  const handleDeviceCodeConnect = async (toolId: string) => {
    setDeviceCodeDialogToolId(toolId);
    setDeviceCodeStatus('loading');
    setDeviceCode('');
    setDeviceCodeUrl('');
    setDeviceCodeDialogOpen(true);

    const result = await dispatch(startDeviceCodeLogin(toolId));
    if (startDeviceCodeLogin.fulfilled.match(result)) {
      const { device_code, device_code_url } = result.payload;
      setDeviceCode(device_code);
      const url = device_code_url || 'https://login.microsoft.com/device';
      setDeviceCodeUrl(url);
      setDeviceCodeStatus('awaiting');

      window.open(url, 'm365-login', 'width=500,height=700,left=200,top=100');

      const poll = setInterval(async () => {
        const statusResult = await dispatch(pollDeviceCodeStatus(toolId));
        if (pollDeviceCodeStatus.fulfilled.match(statusResult)) {
          const { status, email } = statusResult.payload;
          if (status === 'connected') {
            clearInterval(poll);
            setDeviceCodeStatus('connected');
            setSnackbar({ open: true, message: `Connected to Microsoft 365${email ? ` as ${email}` : ''}! Discovering actions…` });
            setDeviceCodeDialogOpen(false);
            setExpandedToolId(toolId);
            await dispatch(fetchToolStatus(toolId));
            dispatch(discoverTools(toolId));
          } else if (status === 'error') {
            clearInterval(poll);
            setDeviceCodeStatus('error');
          }
        }
      }, 2000);

      setTimeout(() => clearInterval(poll), 300000);
    } else {
      setDeviceCodeStatus('error');
    }
  };

  const handleM365Disconnect = async (toolId: string) => {
    await dispatch(disconnectM365(toolId));
    setSnackbar({ open: true, message: 'Disconnected from Microsoft 365' });
  };

  const openCredentialsDialog = (toolId: string, integration: Integration) => {
    const tool = items[toolId];
    const existing = tool?.credentials || {};
    const initial: Record<string, string> = {};
    for (const field of integration.credentialFields || []) {
      initial[field.key] = existing[field.key] || '';
    }
    setCredDialogToolId(toolId);
    setCredDialogIntegration(integration);
    setCredDialogValues(initial);
    setCredDialogOpen(true);
  };

  const handleCredentialsSave = async () => {
    if (!credDialogToolId || !credDialogIntegration) return;
    const hasEmpty = (credDialogIntegration.credentialFields || []).some((f) => !credDialogValues[f.key]?.trim());
    if (hasEmpty) return;

    setCredDialogSaving(true);
    try {
      const result = await dispatch(updateTool({
        id: credDialogToolId,
        credentials: credDialogValues,
        auth_type: 'env_vars',
        auth_status: 'connected',
      }));
      if (updateTool.fulfilled.match(result)) {
        setCredDialogOpen(false);
        setSnackbar({ open: true, message: `${credDialogIntegration.name} connected! Re-discovering actions…` });
        dispatch(discoverTools(credDialogToolId));
      } else {
        setSnackbar({ open: true, message: 'Failed to save credentials', severity: 'error' });
      }
    } finally {
      setCredDialogSaving(false);
    }
  };

  const handleSlackAutoConnect = async () => {
    if (!credDialogToolId || !credDialogIntegration) return;
    const slackBridge = (window as any).openswarm?.connectSlack;
    if (!slackBridge) {
      setSnackbar({ open: true, message: 'Slack auto-connect requires the desktop app', severity: 'error' });
      return;
    }
    setCredDialogSaving(true);
    try {
      const { token, cookie } = await slackBridge();
      const creds = { SLACK_MCP_XOXC_TOKEN: token, SLACK_MCP_XOXD_TOKEN: cookie };
      const result = await dispatch(updateTool({
        id: credDialogToolId,
        credentials: creds,
        auth_type: 'env_vars',
        auth_status: 'connected',
      }));
      if (updateTool.fulfilled.match(result)) {
        setCredDialogOpen(false);
        setSnackbar({ open: true, message: 'Slack connected! Re-discovering actions…' });
        dispatch(discoverTools(credDialogToolId));
      } else {
        setSnackbar({ open: true, message: 'Failed to save Slack credentials', severity: 'error' });
      }
    } catch (err: any) {
      setSnackbar({ open: true, message: err?.message || 'Slack sign-in cancelled', severity: 'error' });
    } finally {
      setCredDialogSaving(false);
    }
  };

  const handleDisconnectIntegration = async (toolId: string, integration: Integration) => {
    if (integration.authType === 'oauth2') {
      fetch(`${API_BASE}/tools/${toolId}/oauth/disconnect`, { method: 'POST' }).catch(() => {});
      const result = await dispatch(updateTool({
        id: toolId,
        oauth_tokens: {},
        auth_status: 'configured',
        connected_account_email: '',
      }));
      if (updateTool.fulfilled.match(result)) {
        setSnackbar({ open: true, message: `${integration.name} disconnected. You can now connect a different account.` });
      } else {
        setSnackbar({ open: true, message: `Failed to disconnect ${integration.name}`, severity: 'error' });
      }
    } else {
      await dispatch(updateTool({
        id: toolId,
        credentials: {},
        auth_type: 'none',
        auth_status: 'configured',
      }));
      setSnackbar({ open: true, message: `${integration.name} disconnected` });
    }
  };

  return {
    dialogOpen, setDialogOpen, editingId, setEditingId, form, setForm,
    registryOpen, setRegistryOpen, regQuery, regSort, regSource, expandedServer, setExpandedServer, snackbar, setSnackbar,
    mcpConfigOpen, setMcpConfigOpen, mcpConfigServer, mcpAuthType, setMcpAuthType, mcpCredentials, setMcpCredentials,
    mcpConfigJson, setMcpConfigJson, mcpConfigError, setMcpConfigError,
    expandedToolId, setExpandedToolId, discovering, integrationLoading,
    expandedServices, setExpandedServices, expandedSchema, setExpandedSchema,
    deviceCodeDialogOpen, setDeviceCodeDialogOpen, deviceCode, deviceCodeUrl, deviceCodeStatus,
    credDialogOpen, setCredDialogOpen, credDialogIntegration, credDialogValues, setCredDialogValues, credDialogSaving,
    handleIntegrationToggle, handleDiscover, handlePermissionChange, handleGroupPermissionChange,
    handleBulkReadOnly, handleResetPermissions, handleBuiltinPermissionChange, handleBuiltinCategoryPermissionChange,
    handleSectionEnabledChange, openCreate, openRegistryBrowser, openEdit, handleSave, handleDelete,
    handleRegSearch, handleLoadMore, handleRegSort, handleRegSourceFilter, handleMcpConfigSave, handleInstall,
    handleEditInstall, handleOAuthConnect, handleDeviceCodeConnect, handleM365Disconnect, openCredentialsDialog,
    handleCredentialsSave, handleSlackAutoConnect, handleDisconnectIntegration,
  };
}
