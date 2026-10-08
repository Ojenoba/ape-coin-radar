import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from "react-router-dom";
import ApeRadar from './ApeRadar'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
 <React.StrictMode>
    <BrowserRouter>
      <ApeRadar />
    </BrowserRouter>
  </React.StrictMode>
);