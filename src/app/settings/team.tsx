import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Modal, TextInput, ListRenderItemInfo,
  Share, Clipboard,
} from 'react-native';
import { Stack } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

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

const ROLE_COLORS: Record<Role, string> = {
  owner: '#3b82f6',
  admin: '#C4704F',
  member: '#B07868',
  viewer: '#B07868',
};

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  member: 'Менеджер',
  viewer: 'Только просмотр',
};

const ASSIGNABLE_ROLES: Role[] = ['admin', 'member', 'viewer'];

export default function TeamScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const currentUser = useUserStore((s) => s.user);
  const queryClient = useQueryClient();

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');

  const [credentials, setCredentials] = useState<{ name: string; username: string; tempPassword: string; companyCode: string | null } | null>(null);

  const { data: members = [], isLoading, error } = useQuery<OrgMember[]>({
    queryKey: ['org-users', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load team');
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
        throw new Error(json.error?.message ?? 'Failed to rotate');
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
    onError: (e: Error) => Alert.alert('Error', e.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/deactivate`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Failed to deactivate');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Error', e.message),
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
        throw new Error(json.error?.message ?? 'Failed to change role');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Error', e.message),
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

  const confirmDeactivate = useCallback((member: OrgMember) => {
    Alert.alert('Удалить доступ', `Убрать ${member.name} из команды?`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => deactivateMutation.mutate(member.id) },
    ]);
  }, [deactivateMutation]);

  const promptRoleChange = useCallback((member: OrgMember) => {
    Alert.alert('Изменить роль', `Выберите роль для ${member.name}`, ASSIGNABLE_ROLES.map((r) => ({
      text: ROLE_LABELS[r],
      onPress: () => roleMutation.mutate({ id: member.id, role: r }),
    })).concat([{ text: 'Отмена', onPress: () => undefined }]));
  }, [roleMutation]);

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
              <Text style={[styles.actionBtnText, { color: '#ef4444' }]}>Убрать</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }, [canManage, isOwner, currentUser?.id, members, confirmDeactivate, promptRoleChange, promptManagerChange]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Команда', headerBackTitle: 'Настройки' }} />
      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#C45A10" />
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

      <Modal visible={showInviteModal} animationType="slide" onRequestClose={() => setShowInviteModal(false)}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Добавить сотрудника</Text>
          <Text style={styles.label}>Имя</Text>
          <TextInput style={styles.input} value={inviteFirstName} onChangeText={setInviteFirstName} placeholder="Иван" placeholderTextColor="#B07868" autoCapitalize="words" />
          <Text style={styles.label}>Фамилия</Text>
          <TextInput style={styles.input} value={inviteLastName} onChangeText={setInviteLastName} placeholder="Петров" placeholderTextColor="#B07868" autoCapitalize="words" />
          <Text style={styles.label}>Роль</Text>
          <View style={styles.roleRow}>
            {ASSIGNABLE_ROLES.map((r) => (
              <TouchableOpacity key={r} style={[styles.rolePill, inviteRole === r && styles.rolePillSelected]} onPress={() => setInviteRole(r)}>
                <Text style={[styles.rolePillText, inviteRole === r && styles.rolePillTextSelected]}>{ROLE_LABELS[r]}</Text>
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
          <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowInviteModal(false)}>
            <Text style={styles.cancelBtnText}>Отмена</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 80 },
  count: { fontSize: 13, color: '#B07868', marginBottom: 12 },
  codeCard: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E8DDD6' },
  codeLabel: { fontSize: 12, fontWeight: '600', color: '#B07868', textTransform: 'uppercase', letterSpacing: 0.5 },
  codeValue: { fontSize: 22, fontWeight: '700', color: '#383432', marginTop: 6, letterSpacing: 1 },
  codeHint: { fontSize: 12, color: '#B07868', marginTop: 8, lineHeight: 17 },
  codeActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  codeCopy: { fontSize: 14, color: '#C45A10', fontWeight: '600' },
  codeRotate: { fontSize: 14, color: '#C45A10', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600', color: '#383432' },
  rowEmail: { fontSize: 12, color: '#B07868', marginTop: 2 },
  rowManager: { fontSize: 11, color: '#C45A10', marginTop: 2 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 6 },
  actionBtn: { borderRadius: 6, borderWidth: 1, borderColor: '#E8DDD6', paddingHorizontal: 8, paddingVertical: 4 },
  deactivateBtn: { borderColor: '#fecaca' },
  actionBtnText: { fontSize: 12, color: '#383432' },
  errorText: { color: '#ef4444', textAlign: 'center', marginTop: 40, paddingHorizontal: 24 },
  inviteButton: { margin: 16, backgroundColor: '#C45A10', borderRadius: 10, padding: 14, alignItems: 'center' },
  inviteButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  modal: { flex: 1, backgroundColor: '#FAF6F3', padding: 24, paddingTop: 60 },
  modalTitle: { fontSize: 22, fontWeight: '700', color: '#383432', marginBottom: 24 },
  label: { fontSize: 13, fontWeight: '600', color: '#383432', marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#E8DDD6', padding: 12, fontSize: 15, color: '#383432' },
  roleRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  rolePill: { borderRadius: 20, borderWidth: 1, borderColor: '#E8DDD6', paddingHorizontal: 14, paddingVertical: 6 },
  rolePillSelected: { backgroundColor: '#C45A10', borderColor: '#C45A10' },
  rolePillText: { fontSize: 13, color: '#383432' },
  rolePillTextSelected: { color: '#fff', fontWeight: '600' },
  cancelBtn: { marginTop: 12, alignItems: 'center', padding: 12 },
  cancelBtnText: { color: '#B07868', fontSize: 15 },
  credOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  credCard: { backgroundColor: '#fff', borderRadius: 16, padding: 24 },
  credTitle: { fontSize: 20, fontWeight: '700', color: '#383432', marginBottom: 8 },
  credSubtitle: { fontSize: 14, color: '#B07868', marginBottom: 20, lineHeight: 20 },
  credLabel: { fontSize: 12, fontWeight: '600', color: '#B07868', marginBottom: 4, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  credRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAF6F3', borderRadius: 8, borderWidth: 1, borderColor: '#E8DDD6', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  credValue: { flex: 1, fontSize: 15, color: '#383432', fontWeight: '600' },
  credCopy: { fontSize: 13, color: '#C45A10', fontWeight: '600' },
  credHint: { fontSize: 12, color: '#CFADA3', marginTop: 16, textAlign: 'center' },
  credShare: { marginTop: 20, backgroundColor: '#383432', borderRadius: 10, padding: 14, alignItems: 'center' },
  credShareText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  credDone: { marginTop: 10, alignItems: 'center', padding: 12 },
  credDoneText: { color: '#B07868', fontSize: 15 },
});
