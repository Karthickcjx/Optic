optic.registerCommand('show-context', context => ({
  title: 'Workspace context',
  columns: ['Setting', 'Value'],
  rows: [
    ['Cluster', context.clusterName || 'No cluster selected'],
    ['Namespace', context.namespace || 'All namespaces']
  ]
}));
