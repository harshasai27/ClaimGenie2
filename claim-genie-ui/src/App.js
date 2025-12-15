import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './components/Home';
import ClaimGenie from './components/ClaimGenie';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path='/' element={<Home/>}></Route>
        <Route path='/chat' element={<ClaimGenie/>}></Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
