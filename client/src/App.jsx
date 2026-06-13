import React from 'react';
import { ProductInventoryGrid } from './components/ProductInventoryGrid.jsx';

export function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Bulk Inventory Editor</h1>
      <p>Adjust price (cents) and stock for products, then save all changes.</p>
      <ProductInventoryGrid />
    </div>
  );
}
