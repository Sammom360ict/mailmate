import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  AppState,
  Image,
  FlatList,
  NativeModules,
  NativeEventEmitter,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import Clipboard from '@react-native-clipboard/clipboard';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

type MailAccount = {email: string; selected: boolean};
type OtpItem = {
  id: string;
  email: string;
  sender: string;
  subject: string;
  code: string;
  date: string;
  receivedAt?: number;
  used: boolean;
};
const ACCOUNTS_KEY = 'mailmate.accounts.v1';
const OTP_KEY = 'mailmate.otps.v1';
const {MailMateNative} = NativeModules;

const colors = {
  ink: '#152B28', muted: '#71817D', line: '#E4EBE8', bg: '#F5F8F6',
  green: '#0E9F6E', pale: '#E5F6EE', red: '#D44848', white: '#FFFFFF', dark: '#10221F',
};

function receivedLabel(item: OtpItem) {
  const timestamp = item.receivedAt ?? Date.parse(item.date);
  if (!Number.isFinite(timestamp)) return 'Received time unavailable';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Received time unavailable';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `Received ${day}/${month}/${date.getFullYear()} · ${date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
}

function AppContent() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [otps, setOtps] = useState<OtpItem[]>([]);
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alias, setAlias] = useState('');
  const [activeTab, setActiveTab] = useState<'inbox' | 'accounts' | 'alias' | 'variations'>('inbox');
  const [variationEmail, setVariationEmail] = useState('');
  const [variationCount, setVariationCount] = useState('100');
  const [variations, setVariations] = useState<string[]>([]);
  const [overlayOn, setOverlayOn] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [visibility, setVisibility] = useState(AppState.currentState);
  const [monitorStatus, setMonitorStatus] = useState('Starting sync…');
  const [checkRequested, setCheckRequested] = useState(false);
  const pendingOverlay = useRef(false);
  const selected = useMemo(() => accounts.filter(a => a.selected), [accounts]);
  const selectedName = selected[0]?.email || accounts[0]?.email || 'No Gmail connected';
  const accountAddresses = useMemo(() => new Set(accounts.map(account => account.email)), [accounts]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', setVisibility);
    return () => listener.remove();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [savedAccounts, savedOtps] = await Promise.all([
          AsyncStorage.getItem(ACCOUNTS_KEY), AsyncStorage.getItem(OTP_KEY),
        ]);
        if (savedAccounts) setAccounts(JSON.parse(savedAccounts));
        if (savedOtps) setOtps(JSON.parse(savedOtps));
      } catch {
        Alert.alert('Could not load data', 'There was a problem loading data stored on this device.');
      } finally { setHydrated(true); }
    })();
  }, []);

  const mergeJournal = useCallback((saved: OtpItem[]) => {
    setOtps(previous => {
      const merged = new Map(previous.map(item => [item.id, item]));
      for (const item of saved) {
        if (accountAddresses.has(item.email)) {
          merged.set(item.id, {...item, used: item.used || !!merged.get(item.id)?.used});
        }
      }
      const time = (item: OtpItem) => item.receivedAt ?? (Date.parse(item.date) || 0);
      return [...merged.values()].sort((a, b) => time(b) - time(a)).slice(0, 100);
    });
  }, [accountAddresses]);

  useEffect(() => {
    if (!hydrated || !MailMateNative) return;
    let current = true;
    const loadJournal = async () => {
      try {
        const saved: OtpItem[] = JSON.parse(await MailMateNative.getOtpJournal());
        if (!current) return;
        mergeJournal(saved);
      } catch {}
    };
    const loadStatus = async () => {
      try {
        const status = await MailMateNative.getMonitorStatus();
        if (current) setMonitorStatus(status);
      } catch {}
    };
    const events = new NativeEventEmitter(MailMateNative);
    const changed = events.addListener('otpJournalChanged', loadJournal);
    const status = events.addListener('syncStatusChanged', loadStatus);
    const closed = events.addListener('overlayClosed', () => setOverlayOn(false));
    loadJournal();
    loadStatus();
    return () => {
      current = false;
      changed.remove();
      status.remove();
      closed.remove();
    };
  }, [hydrated, mergeJournal, visibility]);

  useEffect(() => { if (hydrated) AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)).catch(() => {}); }, [accounts, hydrated]);
  useEffect(() => { if (hydrated) AsyncStorage.setItem(OTP_KEY, JSON.stringify(otps)).catch(() => {}); }, [otps, hydrated]);

  useEffect(() => {
    if (!hydrated || !MailMateNative || visibility === 'background' || visibility === 'inactive') return;
    let current = true;
    (async () => {
      try {
        const credentials = await Promise.all(selected.map(async account => {
          const stored = await Keychain.getGenericPassword({service: `mailmate:${account.email}`});
          return stored ? {email: account.email, password: stored.password} : null;
        }));
        if (!current) return;
        const available = credentials.filter(item => item !== null);
        await MailMateNative.configureMonitoring(JSON.stringify(available));
        if (current && available.length < selected.length) setMonitorStatus('Reconnect Gmail to sync');
      } catch {
        if (current) setMonitorStatus('Could not start sync');
      }
    })();
    return () => { current = false; };
  }, [hydrated, selected, visibility]);

  const connect = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = appPassword.replace(/\s/g, '');
    if (!/^[^\s@]+@gmail\.com$/i.test(normalizedEmail)) {
      Alert.alert('Enter a Gmail address', 'Connect a Gmail account to continue.'); return;
    }
    if (normalizedPassword.length < 16) {
      Alert.alert('Check the App Password', 'A Google App Password is usually 16 characters.'); return;
    }
    setBusy(true);
    try {
      await MailMateNative.verifyGmail(normalizedEmail, normalizedPassword);
      await Keychain.setGenericPassword(normalizedEmail, normalizedPassword, {service: `mailmate:${normalizedEmail}`});
      setAccounts(prev => {
        const found = prev.some(a => a.email === normalizedEmail);
        return found ? prev.map(a => a.email === normalizedEmail ? {...a, selected: true} : a) : [...prev, {email: normalizedEmail, selected: true}];
      });
      setEmail(''); setAppPassword(''); setAdding(false); setActiveTab('accounts');
      Alert.alert('Gmail connected', `${normalizedEmail} is now connected.`);
    } catch (e: any) {
      Alert.alert('Connection failed', e?.message || 'Check the App Password and network connection.');
    } finally { setBusy(false); }
  };

  const toggleAccount = (address: string) => setAccounts(prev => prev.map(a => a.email === address ? {...a, selected: !a.selected} : a));
  const selectAll = (value: boolean) => setAccounts(prev => prev.map(a => ({...a, selected: value})));
  const removeAccount = (address: string) => Alert.alert('Remove Gmail account?', `${address} and its App Password stored by this app will be deleted.`, [
    {text: 'Cancel', style: 'cancel'},
    {text: 'Remove', style: 'destructive', onPress: async () => {
      await Keychain.resetGenericPassword({service: `mailmate:${address}`});
      setAccounts(prev => prev.filter(a => a.email !== address));
      await MailMateNative.clearAccountOtps(address);
      setOtps(prev => prev.filter(o => o.email !== address));
    }},
  ]);

  const refresh = async () => {
    if (!selected.length) { setActiveTab('accounts'); return; }
    setCheckRequested(true);
    try {
      const saved: OtpItem[] = JSON.parse(await MailMateNative.requestSync());
      mergeJournal(saved);
    } catch (error: any) {
      Alert.alert('Could not check Gmail', error?.message || 'Try again in a moment.');
    } finally {
      setCheckRequested(false);
    }
  };

  const copyOtp = async (item: OtpItem) => {
    Clipboard.setString(item.code);
    setOtps(prev => prev.map(o => o.id === item.id ? {...o, used: true} : o));
    await MailMateNative.markOtpUsed(item.id);
  };

  const setFloating = useCallback(async (value: boolean) => {
    if (!(await MailMateNative.setOverlayVisible(value))) {
      Alert.alert('Could not show floating window', 'Check overlay permission and wait for Gmail sync to start.');
      return;
    }
    setOverlayOn(value);
  }, []);

  useEffect(() => {
    if (visibility !== 'active' || !pendingOverlay.current) return;
    pendingOverlay.current = false;
    MailMateNative.canDrawOverlays().then((allowed: boolean) => {
      if (allowed) return setFloating(true);
    }).catch(() => {});
  }, [setFloating, visibility]);

  const toggleOverlay = async (value: boolean) => {
    if (Platform.OS !== 'android' || !MailMateNative) return;
    try {
      if (value) {
        if (!selected.length) { setActiveTab('accounts'); return; }
        if (!(await MailMateNative.canDrawOverlays())) {
          pendingOverlay.current = true;
          await MailMateNative.requestOverlayPermission();
          return;
        }
      }
      await setFloating(value);
    } catch {
      Alert.alert('Could not change floating window', 'Please try again.');
    }
  };

  const makeAlias = () => {
    const base = selected[0]?.email || accounts[0]?.email;
    if (!base) { Alert.alert('Gmail required', 'Connect a Gmail account before creating an alias.'); return; }
    const tag = alias.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (!tag) { Alert.alert('Enter an alias tag', 'Use English letters, numbers, dots, or hyphens.'); return; }
    Clipboard.setString(`${base.replace('@gmail.com', '')}+${tag}@gmail.com`);
    Alert.alert('Alias copied', `${base.replace('@gmail.com', '')}+${tag}@gmail.com`);
  };

  const generateVariations = () => {
    const address = variationEmail.trim().toLowerCase();
    const count = Number(variationCount);
    if (!/^[a-z0-9]+(?:[._%+-][a-z0-9]+)*@[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(address)) {
      Alert.alert('Invalid email', 'Enter a valid email address.');
      return;
    }
    if (!/^\d+$/.test(variationCount) || !Number.isInteger(count) || count < 10 || count > 500) {
      Alert.alert('Invalid quantity', 'Enter a number from 10 to 500.');
      return;
    }
    const [local, domain] = address.split('@');
    if (local.length + String(count - 1).length > 64 || address.length + String(count - 1).length > 254) {
      Alert.alert('Email too long', 'Use a shorter email address to generate variations.');
      return;
    }
    setVariations(Array.from({length: count}, (_, index) => index === 0 ? address : `${local}${index}@${domain}`));
  };

  const copyVariation = (value: string, all = false) => {
    Clipboard.setString(value);
    Alert.alert(all ? 'All variations copied' : 'Copied', all ? `${variations.length} email addresses copied.` : value);
  };

  return <SafeAreaView style={s.safe}>
    <StatusBar barStyle="dark-content" />
    <View style={s.header}>
      <View style={s.brandGroup}>
        <Image source={require('./assets/mailmate-logo.png')} style={s.brandIcon} />
        <Text style={s.brand}>Mail Mate</Text>
      </View>
      <View style={s.syncBadge}>
        <View style={[s.dot, monitorStatus === 'Sync active' && selected.length > 0 && s.liveDot]} />
        <Text style={s.syncText}>{selected.length ? monitorStatus : 'Sync paused'}</Text>
      </View>
    </View>
    {activeTab === 'variations' ? <>
      <FlatList
        data={variations}
        keyExtractor={item => item}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.content}
        ListHeaderComponent={<View style={s.variationHeader}>
          <Text style={s.title}>Email variations</Text>
          <Text style={s.help}>Create lowercase variations without connecting an account.</Text>
          <View style={s.card}>
            <Text style={s.label}>Email address</Text>
            <TextInput accessibilityLabel="Variation email address" value={variationEmail} onChangeText={setVariationEmail}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="name@example.com" placeholderTextColor="#60776E" style={s.input}/>
            <Text style={s.label}>Number of variations (10–500)</Text>
            <TextInput accessibilityLabel="Number of variations" value={variationCount} onChangeText={setVariationCount}
              keyboardType="number-pad" maxLength={3} style={s.input}/>
            <View style={s.row}>
              <Pressable accessibilityRole="button" style={[s.primary, s.grow]} onPress={generateVariations}><Text style={s.primaryText}>Generate</Text></Pressable>
              <Pressable accessibilityRole="button" style={s.resetButton} onPress={() => {setVariationEmail(''); setVariationCount('100'); setVariations([]);}}><Text style={s.refreshText}>Reset</Text></Pressable>
            </View>
            <Text style={s.help}>Numbered addresses may belong to different inboxes.</Text>
          </View>
          {variations.length > 0 && <Text style={s.label}>{variations.length} variations generated</Text>}
        </View>}
        renderItem={({item}) => <View style={s.variationRow}>
          <Text selectable style={[s.email, s.grow]}>{item}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${item}`} style={s.refresh} onPress={() => copyVariation(item)}><Text style={s.refreshText}>Copy</Text></Pressable>
        </View>}
      />
      {variations.length > 0 && <View style={s.copyBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy all variations" style={s.primary} onPress={() => copyVariation(variations.join('\n'), true)}><Text style={s.primaryText}>Copy all {variations.length} addresses</Text></Pressable>
      </View>}
    </> : <ScrollView key={activeTab} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      {activeTab === 'inbox' && <>
        <View style={s.sectionHead}>
          <View style={s.grow}>
            <Text style={s.title}>OTP Inbox</Text>
            <Text style={s.sectionSub}>{selected.length} Gmail {selected.length === 1 ? 'account' : 'accounts'} selected</Text>
          </View>
          <Pressable accessibilityRole="button" style={s.refresh} onPress={refresh} disabled={checkRequested}>
            <Text style={s.refreshText}>{checkRequested ? 'Checking…' : 'Check now'}</Text>
          </Pressable>
        </View>
        <View style={s.overlayCard}>
          <View style={s.grow}>
            <Text style={s.overlayTitle}>Floating window</Text>
            <Text style={s.overlaySub}>Show your latest OTP above other apps.</Text>
          </View>
          <Switch accessibilityLabel="Floating window" value={overlayOn} onValueChange={toggleOverlay}
            trackColor={{false: '#527269', true: '#8CE4BC'}} thumbColor={colors.white} />
        </View>
        {!otps.length ? <View style={s.empty}>
          <Text style={s.emptyTitle}>No OTPs yet</Text>
          <Text style={s.emptyCopy}>{selected.length ? 'New codes will appear here automatically.' : 'Select a Gmail account to start receiving codes.'}</Text>
          {selected.length === 0 && <Pressable style={s.primary} onPress={() => {setAdding(!accounts.length); setActiveTab('accounts');}}>
            <Text style={s.primaryText}>{accounts.length ? 'Select Gmail accounts' : 'Connect Gmail'}</Text>
          </Pressable>}
        </View> : <View style={s.list}>{otps.map(item => <View style={s.otpCard} key={item.id}>
          <View style={s.sectionHead}>
            <Text style={s.otpCode} selectable>{item.code}</Text>
            <Text style={[s.status, item.used ? s.usedStatus : s.newStatus]}>{item.used ? 'Used' : 'New'}</Text>
          </View>
          <Text style={s.otpSubject} numberOfLines={2}>{item.subject || 'Verification code'}</Text>
          <Text style={s.receivedAt}>{receivedLabel(item)}</Text>
          <View style={s.row}>
            <Text style={[s.sectionSub, s.grow]} numberOfLines={1}>{item.email}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Copy OTP ${item.code}`} style={s.refresh} onPress={() => copyOtp(item)}>
              <Text style={s.refreshText}>Copy</Text>
            </Pressable>
          </View>
        </View>)}</View>}
      </>}
      {activeTab === 'accounts' && <>
        <Text style={s.title}>Gmail accounts</Text>
        {!!accounts.length && <View style={s.card}>
          <View style={s.row}>
            <Text style={[s.label, s.grow]}>Select all accounts</Text>
            <Switch accessibilityLabel="Select all accounts" value={accounts.every(a => a.selected)} onValueChange={selectAll}
              trackColor={{false:'#C9D4D0',true:'#75D5B1'}} thumbColor={colors.white}/>
          </View>
          {accounts.map(a => <View key={a.email} style={s.accountRow}>
            <Pressable accessibilityRole="checkbox" accessibilityState={{checked: a.selected}}
              style={[s.row, s.grow]} onPress={() => toggleAccount(a.email)}>
              <Text style={[s.check, a.selected && s.checked]}>{a.selected ? '✓' : ''}</Text>
              <Text style={[s.email, s.grow]} numberOfLines={2}>{a.email}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.email}`} style={s.smallButton} onPress={() => removeAccount(a.email)}>
              <Text style={s.remove}>Remove</Text>
            </Pressable>
          </View>)}
        </View>}
        {adding ? <View style={s.card}>
          <Text style={s.label}>Gmail address</Text>
          <TextInput accessibilityLabel="Gmail address" value={email} onChangeText={setEmail} autoCapitalize="none"
            autoCorrect={false} keyboardType="email-address" placeholder="name@gmail.com" placeholderTextColor="#60776E" style={s.input}/>
          <Text style={s.label}>Google App Password</Text>
          <TextInput accessibilityLabel="Google App Password" value={appPassword} onChangeText={setAppPassword}
            autoCapitalize="none" secureTextEntry placeholder="16-character App Password" placeholderTextColor="#60776E" style={s.input}/>
          <Text style={s.help}>Create an App Password after enabling 2-Step Verification in your Google Account.</Text>
          <Pressable style={[s.primary,busy && s.dimmed]} onPress={connect} disabled={busy}>
            <Text style={s.primaryText}>{busy ? 'Connecting…' : 'Connect securely'}</Text>
          </Pressable>
        </View> : <Pressable style={s.primary} onPress={() => setAdding(true)}><Text style={s.primaryText}>Connect Gmail</Text></Pressable>}
      </>}
      {activeTab === 'alias' && <>
        <Text style={s.title}>Gmail alias</Text>
        <View style={s.card}>
          <Text style={s.help}>Messages sent to a +tag alias arrive in the same inbox.</Text>
          <Text style={s.label}>Alias tag</Text>
          <TextInput accessibilityLabel="Alias tag" value={alias} onChangeText={setAlias} autoCapitalize="none"
            autoCorrect={false} placeholder="shopping" placeholderTextColor="#60776E" style={s.input}/>
          <Text style={s.help}>{selectedName}</Text>
          <Pressable style={s.primary} onPress={makeAlias}><Text style={s.primaryText}>Create and copy alias</Text></Pressable>
        </View>
      </>}
    </ScrollView>}
    <View style={s.tabBar}>
      {([['inbox', 'Inbox'], ['accounts', 'Gmail'], ['alias', 'Alias'], ['variations', 'Variations']] as const).map(([tab, label]) =>
        <Pressable accessibilityRole="tab" accessibilityState={{selected: activeTab === tab}} key={tab}
          style={[s.tab, activeTab === tab && s.tabActive]} onPress={() => setActiveTab(tab)}>
          <Text style={[s.tabLabel, activeTab === tab && s.tabLabelActive]}>{label}</Text>
        </Pressable>)}
    </View>
  </SafeAreaView>;

}

export default function App() { return <SafeAreaProvider><AppContent/></SafeAreaProvider>; }

const s = StyleSheet.create({
  safe: {flex: 1, backgroundColor: colors.bg},
  header: {paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  brandGroup: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1},
  brandIcon: {width: 34, height: 34, borderRadius: 9},
  brand: {flexShrink: 1, fontSize: 23, fontWeight: '800', letterSpacing: -.6, color: colors.dark},
  syncBadge: {flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.pale, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 20},
  dot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#7A8D85'},
  liveDot: {backgroundColor: '#117652'},
  syncText: {fontSize: 12, fontWeight: '700', color: '#15543E', flexShrink: 1},
  content: {padding: 20, gap: 16},
  title: {flexShrink: 1, fontSize: 29, fontWeight: '800', letterSpacing: -.7, color: colors.dark},
  sectionHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  sectionSub: {fontSize: 13, color: '#50675E', marginTop: 3},
  overlayCard: {backgroundColor: '#102923', borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 8},
  overlayTitle: {fontSize: 16, fontWeight: '800', color: colors.white},
  overlaySub: {fontSize: 13, color: '#C1DDD2', marginTop: 4},
  refresh: {minHeight: 44, paddingHorizontal: 13, justifyContent: 'center', backgroundColor: colors.pale, borderRadius: 12},
  refreshText: {fontSize: 13, fontWeight: '700', color: '#145C43'},
  empty: {backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 22, alignItems: 'center', gap: 8},
  emptyTitle: {fontSize: 17, fontWeight: '800', color: colors.ink},
  emptyCopy: {fontSize: 14, textAlign: 'center', color: '#50675E'},
  primary: {minHeight: 48, justifyContent: 'center', backgroundColor: '#126747', padding: 12, borderRadius: 13, alignItems: 'center'},
  primaryText: {fontSize: 14, fontWeight: '800', color: colors.white},
  list: {gap: 10},
  otpCard: {gap: 5, padding: 16, backgroundColor: colors.white, borderRadius: 17, borderWidth: 1, borderColor: colors.line},
  otpCode: {flexShrink: 1, fontSize: 25, fontFamily: 'monospace', fontWeight: '800', color: colors.dark},
  otpSubject: {fontSize: 14, fontWeight: '600', color: colors.ink},
  receivedAt: {fontSize: 12, color: '#50675E'},
  status: {paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, fontSize: 12, fontWeight: '700'},
  usedStatus: {backgroundColor: '#FCE9E8', color: '#9C3434'},
  newStatus: {backgroundColor: colors.pale, color: '#145C43'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 10},
  card: {backgroundColor: colors.white, borderRadius: 17, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line},
  accountRow: {flexDirection: 'row', alignItems: 'center', gap: 6, borderTopWidth: 1, borderColor: colors.line},
  check: {width: 23, height: 23, borderRadius: 6, borderWidth: 1, borderColor: '#7D968A', textAlign: 'center', color: colors.white, fontWeight: '800'},
  checked: {backgroundColor: '#126747', borderColor: '#126747'},
  email: {fontSize: 13, fontWeight: '600', color: colors.ink},
  smallButton: {minHeight: 44, justifyContent: 'center', paddingHorizontal: 6},
  remove: {fontSize: 12, color: '#9C3434', fontWeight: '700'},
  variationHeader: {gap: 12, marginBottom: 10},
  variationRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8, backgroundColor: colors.white, borderRadius: 12, borderWidth: 1, borderColor: colors.line},
  resetButton: {minHeight: 48, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: colors.pale, borderRadius: 13},
  copyBar: {paddingHorizontal: 20, paddingVertical: 10, backgroundColor: colors.white, borderTopWidth: 1, borderColor: colors.line},
  tabBar: {backgroundColor: colors.white, borderTopColor: colors.line, borderTopWidth: 1, flexDirection: 'row', gap: 8, padding: 8},
  tab: {flex: 1, minHeight: 46, padding: 7, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  tabActive: {backgroundColor: colors.pale},
  tabLabel: {fontSize: 12, fontWeight: '700', color: '#50675E'},
  tabLabelActive: {color: '#145C43'},
  label: {fontSize: 14, fontWeight: '700', color: colors.ink},
  input: {minHeight: 48, borderWidth: 1, borderColor: '#BFCDC6', borderRadius: 12, paddingHorizontal: 13, color: colors.ink, fontSize: 14},
  help: {fontSize: 13, lineHeight: 19, color: '#50675E'},
  grow: {flex: 1},
  dimmed: {opacity: .6},
});
