import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Modal, TextInput, ListRenderItemInfo,
  Share, Clipboard, ScrollView,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

/**
 * Mirrors backend/services/capabilities.ts. The backend is authoritative — it
 * refuses anything this list gets wrong — but the two must be edited together
 * when a role is added, or the picker silently omits it.
 */
type Role =
  | 'owner'
  | 'admin'
  | 'head'
  | 'member'
  | 'accountant'
  | 'marketer'
  | 'support'
  | 'viewer';

interface OrgMember {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: Role;
  manager_id: string | null;
}

interface CompanyCode {
  company_code: string;
  expires_at: string;
}

// Blue marks the account that owns the org; warm tones mark everyone who can
// change data; muted grey marks the roles that can only look.
const ROLE_COLORS: Record<Role, string> = {
  owner: '#3b82f6',
  admin: '#CC785C',
  head: '#CC785C',
  member: '#D4A27F',
  marketer: '#D4A27F',
  support: '#D4A27F',
  accountant: '#8FA3AD',
  viewer: '#8FA3AD',
};

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  head: 'Руководитель отдела',
  member: 'Менеджер',
  accountant: 'Бухгалтер',
  marketer: 'Маркетолог',
  support: 'Поддержка',
  viewer: 'Только просмотр',
};

/** One line each, so the picker explains the choice instead of just naming it. */
const ROLE_HINTS: Record<Role, string> = {
  owner: 'Полный доступ, включая передачу владения',
  admin: 'Полный доступ, кроме назначения администраторов',
  head: 'Как менеджер, плюс данные своих подчинённых',
  member: 'Свои контакты, сделки и задачи',
  accountant: 'Видит все деньги и выгрузки. Не может ничего менять',
  marketer: 'Рассылки и шаблоны по всей базе. Без правки сделок',
  support: 'Контакты и активность. Без воронки и сумм',
  viewer: 'Видит свои данные. Не может ничего менять',
};

// `admin` is offered only to an owner; the backend enforces the same rule via
// the team.manage_admins capability, so a tampered client gains nothing.
const ASSIGNABLE_ROLES: Role[] = ['head', 'member', 'accountant', 'marketer', 'support', 'viewer'];

export default function TeamScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const currentUser = useUserStore((s) => s.user);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  // Read here, not inside the Modal: a full-screen Modal draws over the status
  // bar, and the insets the navigator reports for this screen are the ones the
  // modal header needs to clear it.
  const insets = useSafeAreaInsets();

  // `/settings/team?add=1` (the Создать sheet shortcut) lands with the form
  // already open. Read once into initial state rather than in an effect, so it
  // does not reopen every time the param is still in the URL after a close.
  const { add } = useLocalSearchParams<{ add?: string }>();
  const [showInviteModal, setShowInviteModal] = useState(add === '1');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');

  const [credentials, setCredentials] = useState<{ name: string; username: string; tempPassword: string; companyCode: string | null } | null>(null);

  const { data: members = [], isLoading, error } = useQuery<OrgMember[]>({
    queryKey: ['org-users', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Не удалось загрузить команду');
      const json = (await res.json()) as { data: OrgMember[] };
      return json.data;
    },
    enabled: !!token,
  });

  const { data: companyCode } = useQuery<CompanyCode | null>({
    queryKey: ['company-code', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/company-code`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const json = (await res.json()) as { data: CompanyCode };
      return json.data;
    },
    enabled: !!token,
  });

  const rotateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_URL}/auth/company-code/rotate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось обновить код');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['company-code'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const inviteMutation = useMutation({
    mutationFn: async (data: { first_name: string; last_name: string; role: Role }) => {
      const res = await fetch(`${API_URL}/auth/users/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = (await res.json()) as { data: { temp_password: string; name: string; username: string; company_code: string | null }; error?: { message: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Invite failed');
      return json.data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['org-users'] });
      setShowInviteModal(false);
      setCredentials({ name: data.name, username: data.username, tempPassword: data.temp_password, companyCode: data.company_code });
      setInviteFirstName(''); setInviteLastName(''); setInviteRole('member');
    },
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/deactivate`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось деактивировать');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const roleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: Role }) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/role`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось изменить роль');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const managerMutation = useMutation({
    mutationFn: async ({ id, manager_id }: { id: string; manager_id: string | null }) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/manager`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager_id }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось назначить руководителя');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const canManage = currentUser?.role === 'owner' || currentUser?.role === 'admin';
  const isOwner = currentUser?.role === 'owner';

  // Only an owner may hand out `admin`. The backend enforces the same rule, so
  // this is presentation, not protection.
  const offeredRoles: Role[] = isOwner ? ['admin', ...ASSIGNABLE_ROLES] : ASSIGNABLE_ROLES;

  // Every way out of the invite form — header arrow, «Отмена», Android hardware
  // back — funnels through here so the three cannot drift apart.
  const closeInviteModal = useCallback(() => setShowInviteModal(false), []);

  const confirmDeactivate = useCallback((member: OrgMember) => {
    Alert.alert('Удалить доступ', `Убрать ${member.name} из команды?`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => deactivateMutation.mutate(member.id) },
    ]);
  }, [deactivateMutation]);

  const promptRoleChange = useCallback((member: OrgMember) => {
    Alert.alert('Изменить роль', `Выберите роль для ${member.name}`, offeredRoles.map((r) => ({
      text: ROLE_LABELS[r],
      onPress: () => roleMutation.mutate({ id: member.id, role: r }),
    })).concat([{ text: 'Отмена', onPress: () => undefined }]));
  }, [roleMutation, offeredRoles]);

  const promptManagerChange = useCallback((member: OrgMember, allMembers: OrgMember[]) => {
    const eligibleManagers = allMembers.filter((m) => m.id !== member.id);
    const options = eligibleManagers.map((m) => ({
      text: m.name,
      onPress: () => managerMutation.mutate({ id: member.id, manager_id: m.id }),
    }));
    options.push({ text: 'Без руководителя', onPress: () => managerMutation.mutate({ id: member.id, manager_id: null }) });
    options.push({ text: 'Отмена', onPress: () => undefined });
    Alert.alert('Руководитель', `Выберите руководителя для ${member.name}`, options);
  }, [managerMutation]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<OrgMember>) => {
    const isSelf = item.id === currentUser?.id;
    const managerName = item.manager_id ? (members.find((m) => m.id === item.manager_id)?.name ?? null) : null;
    return (
      <View style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: ROLE_COLORS[item.role] }]}>
          <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName}>{item.name}{isSelf ? ' (вы)' : ''}</Text>
          <Text style={styles.rowEmail}>{item.email ?? item.username ?? ''}</Text>
          {managerName !== null ? (
            <Text style={styles.rowManager}>↑ {managerName}</Text>
          ) : null}
        </View>
        <View style={[styles.badge, { backgroundColor: ROLE_COLORS[item.role] + '22' }]}>
          <Text style={[styles.badgeText, { color: ROLE_COLORS[item.role] }]}>{ROLE_LABELS[item.role]}</Text>
        </View>
        {canManage && !isSelf && item.role !== 'owner' && (
          <View style={styles.actions}>
            {isOwner && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => promptRoleChange(item)}>
                <Text style={styles.actionBtnText}>Роль</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.actionBtn} onPress={() => promptManagerChange(item, members)}>
              <Text style={styles.actionBtnText}>Рук-ль</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.deactivateBtn]} onPress={() => confirmDeactivate(item)}>
              <Text style={[styles.actionBtnText, { color: colors.red }]}>Убрать</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }, [canManage, isOwner, currentUser?.id, members, confirmDeactivate, promptRoleChange, promptManagerChange, styles, colors.red]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Команда', headerBackTitle: 'Настройки' }} />
      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.orange} />
      ) : error ? (
        <Text style={styles.errorText}>{(error as Error).message}</Text>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View>
              {canManage && companyCode && (
                <View style={styles.codeCard}>
                  <Text style={styles.codeLabel}>Код компании</Text>
                  <Text style={styles.codeValue} selectable>{companyCode.company_code}</Text>
                  <Text style={styles.codeHint}>
                    Сотрудники вводят его при первом входе. Действует до {new Date(companyCode.expires_at).toLocaleDateString('ru-RU')}.
                  </Text>
                  <View style={styles.codeActions}>
                    <TouchableOpacity onPress={() => { Clipboard.setString(companyCode.company_code); Alert.alert('Скопировано'); }}>
                      <Text style={styles.codeCopy}>Копировать</Text>
                    </TouchableOpacity>
                    {isOwner && (
                      <TouchableOpacity
                        onPress={() => Alert.alert('Новый код', 'Старый код перестанет работать. Продолжить?', [
                          { text: 'Отмена', style: 'cancel' },
                          { text: 'Создать', onPress: () => rotateMutation.mutate() },
                        ])}
                        disabled={rotateMutation.isPending}
                      >
                        <Text style={styles.codeRotate}>{rotateMutation.isPending ? 'Обновление…' : 'Сгенерировать новый'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              )}
              <Text style={styles.count}>{members.length} {members.length === 1 ? 'участник' : 'участников'}</Text>
            </View>
          }
        />
      )}
      {canManage && (
        <TouchableOpacity style={styles.inviteButton} onPress={() => setShowInviteModal(true)}>
          <Text style={styles.inviteButtonText}>+ Добавить сотрудника</Text>
        </TouchableOpacity>
      )}

      <Modal visible={credentials !== null} animationType="fade" transparent onRequestClose={() => setCredentials(null)}>
        <View style={styles.credOverlay}>
          <View style={styles.credCard}>
            <Text style={styles.credTitle}>Участник добавлен</Text>
            <Text style={styles.credSubtitle}>
              Передайте <Text style={{ fontWeight: '700' }}>{credentials?.name}</Text> эти данные для входа:
            </Text>

            {credentials?.companyCode != null && (
              <>
                <Text style={styles.credLabel}>Код компании</Text>
                <View style={styles.credRow}>
                  <Text style={styles.credValue} selectable>{credentials.companyCode}</Text>
                  <TouchableOpacity onPress={() => { Clipboard.setString(credentials.companyCode ?? ''); Alert.alert('Скопировано'); }}>
                    <Text style={styles.credCopy}>Копировать</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            <Text style={styles.credLabel}>Имя пользователя</Text>
            <View style={styles.credRow}>
              <Text style={styles.credValue} selectable>{credentials?.username}</Text>
              <TouchableOpacity onPress={() => { Clipboard.setString(credentials?.username ?? ''); Alert.alert('Скопировано'); }}>
                <Text style={styles.credCopy}>Копировать</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.credLabel}>Временный пароль</Text>
            <View style={styles.credRow}>
              <Text style={styles.credValue} selectable>{credentials?.tempPassword}</Text>
              <TouchableOpacity onPress={() => { Clipboard.setString(credentials?.tempPassword ?? ''); Alert.alert('Скопировано'); }}>
                <Text style={styles.credCopy}>Копировать</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.credHint}>Участник укажет свой email и пароль при первом входе</Text>

            <TouchableOpacity
              style={styles.credShare}
              onPress={() => {
                void Share.share({
                  message: `Привет, ${credentials?.name ?? ''}! Тебя добавили в 4КУБ.\n\n1. Скачай приложение:\nhttps://4kub.ru\n\n2. Открой приложение и нажми «Я новый сотрудник»\n\n3. Введи:\nКод компании: ${credentials?.companyCode ?? ''}\nИмя: ${credentials?.username ?? ''}\nПароль: ${credentials?.tempPassword ?? ''}\n\nПри входе тебя попросят указать свой email и придумать пароль — это займёт 10 секунд.`,
                });
              }}
            >
              <Text style={styles.credShareText}>Поделиться</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.credDone} onPress={() => setCredentials(null)}>
              <Text style={styles.credDoneText}>Готово</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showInviteModal} animationType="slide" onRequestClose={closeInviteModal}>
        <View style={styles.modal}>
          {/*
            A full-screen Modal covers the navigator, taking the global NavHeader
            — and with it the only back arrow — off screen. NavHeader itself is
            not reusable here: its arrow is route-driven (router.back()), which
            would abandon the team screen rather than dismiss this form. So this
            repeats NavHeader's geometry (52pt row, 26px arrow, 18/700 title) and
            wires it to the modal instead.
          */}
          <View style={[styles.modalHeader, { paddingTop: insets.top }]}>
            <View style={styles.modalHeaderRow}>
              <TouchableOpacity
                onPress={closeInviteModal}
                style={styles.modalBackBtn}
                accessibilityRole="button"
                accessibilityLabel="Назад"
                hitSlop={8}
              >
                <ArrowLeft size={26} color={colors.text1} strokeWidth={2.4} />
              </TouchableOpacity>
              <Text style={styles.modalHeaderTitle} numberOfLines={1}>Добавить сотрудника</Text>
            </View>
          </View>
          {/* Up to seven role cards plus two inputs overflow a small screen,
              which would otherwise strand «Добавить» below the fold. */}
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Имя</Text>
            <TextInput style={styles.input} value={inviteFirstName} onChangeText={setInviteFirstName} placeholder="Иван" placeholderTextColor={colors.placeholder} autoCapitalize="words" />
            <Text style={styles.label}>Фамилия</Text>
            <TextInput style={styles.input} value={inviteLastName} onChangeText={setInviteLastName} placeholder="Петров" placeholderTextColor={colors.placeholder} autoCapitalize="words" />
            <Text style={styles.label}>Роль</Text>
            <View style={styles.roleList}>
              {offeredRoles.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.roleOption, inviteRole === r && styles.roleOptionSelected]}
                  onPress={() => setInviteRole(r)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: inviteRole === r }}
                >
                  <View style={[styles.roleDot, { backgroundColor: ROLE_COLORS[r] }]} />
                  <View style={styles.roleOptionText}>
                    <Text style={[styles.rolePillText, inviteRole === r && styles.rolePillTextSelected]}>{ROLE_LABELS[r]}</Text>
                    <Text style={styles.roleHint}>{ROLE_HINTS[r]}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.inviteButton, { marginTop: 24 }]}
              onPress={() => inviteMutation.mutate({ first_name: inviteFirstName, last_name: inviteLastName, role: inviteRole })}
              disabled={inviteMutation.isPending || !inviteFirstName.trim() || !inviteLastName.trim()}
            >
              <Text style={styles.inviteButtonText}>{inviteMutation.isPending ? 'Добавление…' : 'Добавить'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={closeInviteModal}>
              <Text style={styles.cancelBtnText}>Отмена</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 80 },
  count: { fontSize: 13, color: c.amber, marginBottom: 12 },
  codeCard: { backgroundColor: c.bgPanel, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.border },
  codeLabel: { fontSize: 12, fontWeight: '600', color: c.amber, textTransform: 'uppercase', letterSpacing: 0.5 },
  codeValue: { fontSize: 22, fontWeight: '700', color: c.text1, marginTop: 6, letterSpacing: 1 },
  codeHint: { fontSize: 12, color: c.amber, marginTop: 8, lineHeight: 17 },
  codeActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  codeCopy: { fontSize: 14, color: c.orange, fontWeight: '600' },
  codeRotate: { fontSize: 14, color: c.orange, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bgPanel, borderRadius: 10, padding: 12, marginBottom: 8, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600', color: c.text1 },
  rowEmail: { fontSize: 12, color: c.amber, marginTop: 2 },
  rowManager: { fontSize: 11, color: c.orange, marginTop: 2 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 6 },
  actionBtn: { borderRadius: 6, borderWidth: 1, borderColor: c.border, paddingHorizontal: 8, paddingVertical: 4 },
  deactivateBtn: { borderColor: 'rgba(204,82,71,0.12)' },
  actionBtnText: { fontSize: 12, color: c.text1 },
  errorText: { color: c.red, textAlign: 'center', marginTop: 40, paddingHorizontal: 24 },
  inviteButton: { margin: 16, backgroundColor: c.orange, borderRadius: 10, padding: 14, alignItems: 'center' },
  inviteButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  modal: { flex: 1, backgroundColor: c.bg },
  // Kept numerically in step with NavHeader so the form reads as a pushed
  // screen rather than a stray sheet; change these only alongside that file.
  modalHeader: { backgroundColor: c.bgDark, borderBottomWidth: 1, borderBottomColor: c.border },
  modalHeaderRow: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  modalBackBtn: { padding: 8 },
  modalHeaderTitle: { fontSize: 18, fontWeight: '700', color: c.text1, marginLeft: 4, flex: 1 },
  modalBody: { padding: 24, paddingBottom: 48 },
  label: { fontSize: 13, fontWeight: '600', color: c.text1, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: c.inputBg, borderRadius: 8, borderWidth: 1, borderColor: c.inputBorder, padding: 12, fontSize: 15, color: c.text1 },
  roleRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  roleList: { gap: 8 },
  roleOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
  },
  roleOptionSelected: { borderColor: c.orange, backgroundColor: c.orange },
  roleOptionText: { flex: 1 },
  roleDot: { width: 10, height: 10, borderRadius: 5 },
  roleHint: { fontSize: 12, color: c.textMuted, marginTop: 2, lineHeight: 16 },
  rolePill: { borderRadius: 20, borderWidth: 1, borderColor: c.border, paddingHorizontal: 14, paddingVertical: 6 },
  rolePillSelected: { backgroundColor: c.orange, borderColor: c.orange },
  rolePillText: { fontSize: 13, color: c.text1 },
  rolePillTextSelected: { color: '#fff', fontWeight: '600' },
  cancelBtn: { marginTop: 12, alignItems: 'center', padding: 12 },
  cancelBtnText: { color: c.amber, fontSize: 15 },
  credOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: 24 },
  credCard: { backgroundColor: c.bgPanel, borderRadius: 16, padding: 24 },
  credTitle: { fontSize: 20, fontWeight: '700', color: c.text1, marginBottom: 8 },
  credSubtitle: { fontSize: 14, color: c.amber, marginBottom: 20, lineHeight: 20 },
  credLabel: { fontSize: 12, fontWeight: '600', color: c.amber, marginBottom: 4, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  credRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bg, borderRadius: 8, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  credValue: { flex: 1, fontSize: 15, color: c.text1, fontWeight: '600' },
  credCopy: { fontSize: 13, color: c.orange, fontWeight: '600' },
  credHint: { fontSize: 12, color: c.textMuted, marginTop: 16, textAlign: 'center' },
  credShare: { marginTop: 20, backgroundColor: c.border, borderRadius: 10, padding: 14, alignItems: 'center' },
  credShareText: { color: c.text1, fontWeight: '700', fontSize: 15 },
  credDone: { marginTop: 10, alignItems: 'center', padding: 12 },
  credDoneText: { color: c.amber, fontSize: 15 },
});
