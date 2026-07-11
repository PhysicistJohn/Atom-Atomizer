import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

document.documentElement.dataset.platform = navigator.platform.startsWith('Mac') ? 'darwin' : 'other';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
