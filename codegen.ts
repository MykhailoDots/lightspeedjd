import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  overwrite: true,
  schema: {
    'https://api-main.jobdone-development.app/v1/graphql': {
      headers: {
        'x-hasura-admin-secret': 'RememberThatTimeWhenWeWentForKaraoke',
      },
    },
  },
  documents: 'src/**/*.graphql',
  generates: {
    'src/graphql/generated/graphql.ts': {
      plugins: [
        'typescript',
        'typescript-resolvers',
        'typescript-operations',
        'typescript-document-nodes',
      ],
    },
    './graphql.schema.json': {
      plugins: ['introspection'],
    },
  },
};

export default config;
