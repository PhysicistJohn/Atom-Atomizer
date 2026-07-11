import React from 'react';
import { createRoot } from 'react-dom/client';
import { DemoLab } from './DemoLab.js';
import './demo-styles.css';

createRoot(document.getElementById('demo-root')!).render(<React.StrictMode><DemoLab/></React.StrictMode>);
