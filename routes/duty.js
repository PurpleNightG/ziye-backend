import express from 'express'
import { pool } from '../config/database.js'

const router = express.Router()

// Auto-create table on first load
;(async () => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS instructor_duty (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(128) NOT NULL,
        nickname VARCHAR(128) NOT NULL,
        clocked_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        clocked_out_at TIMESTAMP NULL,
        date DATE NOT NULL,
        INDEX idx_date (date),
        INDEX idx_username (username)
      )
    `)
  } catch (e) {
    console.error('Failed to create instructor_duty table:', e.message)
  }
})()

// Clock in
router.post('/clock-in', async (req, res) => {
  try {
    const { username, nickname } = req.body
    if (!username) return res.status(400).json({ success: false, error: 'username required' })
    const today = new Date().toISOString().slice(0, 10)
    // Prevent duplicate clock-in on the same day
    const [existing] = await pool.execute(
      `SELECT id FROM instructor_duty WHERE username = ? AND date = ? AND clocked_out_at IS NULL`,
      [username, today]
    )
    if (existing.length > 0) {
      return res.json({ success: true, alreadyOnDuty: true })
    }
    await pool.execute(
      `INSERT INTO instructor_duty (username, nickname, date) VALUES (?, ?, ?)`,
      [username, nickname || username, today]
    )
    res.json({ success: true, alreadyOnDuty: false })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Clock out
router.post('/clock-out', async (req, res) => {
  try {
    const { username } = req.body
    if (!username) return res.status(400).json({ success: false, error: 'username required' })
    const today = new Date().toISOString().slice(0, 10)
    await pool.execute(
      `UPDATE instructor_duty SET clocked_out_at = NOW() WHERE username = ? AND date = ? AND clocked_out_at IS NULL`,
      [username, today]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Get today's on-duty instructors (currently clocked in, not yet clocked out)
router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const [rows] = await pool.execute(
      `SELECT username, nickname, clocked_in_at FROM instructor_duty
       WHERE date = ? AND clocked_out_at IS NULL ORDER BY clocked_in_at ASC`,
      [today]
    )
    res.json({ success: true, instructors: rows })
  } catch (e) {
    res.json({ success: false, instructors: [] })
  }
})

// Get current duty status for a specific admin user
router.get('/status/:username', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const [rows] = await pool.execute(
      `SELECT id, clocked_in_at FROM instructor_duty
       WHERE username = ? AND date = ? AND clocked_out_at IS NULL`,
      [req.params.username, today]
    )
    res.json({ success: true, onDuty: rows.length > 0, clockedInAt: rows[0]?.clocked_in_at || null })
  } catch (e) {
    res.json({ success: false, onDuty: false, clockedInAt: null })
  }
})

export default router
