import { fileColumnRegistrar } from '../fileColumnRegistrar';

fileColumnRegistrar.registerColumn('child', 'linkIcon', () => ({
  draw(row, node) {
    if (node.symbolicLink) {
      row.add('→');
    }
  },
}));
