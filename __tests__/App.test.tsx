import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));
jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn()}));
jest.mock('react-native-safe-area-context', () => {
  const {View} = require('react-native');
  return {SafeAreaProvider: ({children}: any) => children, SafeAreaView: View};
});

test('renders the English OTP inbox', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
  const labels = renderer!.root
    .findAll(node => typeof node.props.children === 'string')
    .map(node => node.props.children as string);
  expect(labels).toContain('OTP Inbox');
  expect(labels).toContain('No OTPs yet');
  expect(labels).toContain('Connect Gmail');
});

test('generates and copies 500 unique lowercase variations without an account', async () => {
  const Clipboard = require('@react-native-clipboard/clipboard');
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<App />); });
  const root = renderer!.root;
  await ReactTestRenderer.act(async () => {
    root.findAll(node => node.props.accessibilityRole === 'tab' && node.findAllByProps({children: 'Variations'}).length > 0)[0].props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    root.findByProps({accessibilityLabel: 'Variation email address'}).props.onChangeText('EX@gmail.com');
    root.findByProps({accessibilityLabel: 'Number of variations'}).props.onChangeText('500');
  });
  await ReactTestRenderer.act(async () => {
    root.findAll(node => node.props.accessibilityRole === 'button' && node.findAllByProps({children: 'Generate'}).length > 0)[0].props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    root.findAllByProps({accessibilityLabel: 'Copy all variations'})[0].props.onPress();
  });
  const copied = Clipboard.setString.mock.calls.at(-1)[0].split('\n');
  expect(copied).toHaveLength(500);
  expect(new Set(copied).size).toBe(500);
  expect(copied[0]).toBe('ex@gmail.com');
  expect(copied[499]).toBe('ex499@gmail.com');
  await ReactTestRenderer.act(async () => { root.findByProps({accessibilityLabel: 'Copy ex@gmail.com'}).props.onPress(); });
  expect(Clipboard.setString).toHaveBeenLastCalledWith('ex@gmail.com');
});
