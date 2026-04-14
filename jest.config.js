/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^dotenv/config$": "<rootDir>/src/__tests__/__mocks__/dotenv.ts",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { ignoreDeprecations: "6.0" } }],
  },
};
