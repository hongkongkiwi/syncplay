module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native|expo|@expo|expo-modules-core|lucide-react-native|@babel/runtime|syncplay-p2p-client)/)'
  ]
};
