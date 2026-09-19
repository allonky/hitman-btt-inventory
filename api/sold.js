// GET /api/sold -> {"sold":{"HBTT-SP-BLINDFOLD":1,...},"updated":"..."}  read by the sponsor page
const { read } = require('./_store');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const d = await read();
  res.status(200).json({ sold: d.sold, updated: d.updated || null });
};
