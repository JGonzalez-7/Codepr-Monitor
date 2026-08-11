from odoo import fields, models


class CodeprMonitorTicket(models.Model):
    _name = "codepr.monitor.ticket"
    _description = "CodePR Monitor Ticket"
    _inherit = ["mail.thread"]
    _order = "submitted_at desc, id desc"

    name = fields.Char(
        string="Subject",
        required=True,
        tracking=True,
    )
    description = fields.Text(string="Details")

    site_name = fields.Char(string="Page", required=True, index=True)
    site_url = fields.Char(string="Page URL")

    submitted_by = fields.Char(string="Submitted by", required=True)
    submitted_at = fields.Datetime(
        string="Submitted at",
        required=True,
        default=fields.Datetime.now,
        help="Timestamp captured by CodePR-Monitor when the client submitted the ticket (UTC).",
    )

    kind = fields.Selection(
        [("issue", "Issue"), ("fix", "Fix request")],
        string="Type",
        default="issue",
        required=True,
        tracking=True,
    )
    state = fields.Selection(
        [("open", "Open"), ("in_progress", "In progress"), ("resolved", "Resolved")],
        string="Status",
        default="open",
        required=True,
        tracking=True,
    )

    monitor_ref = fields.Char(
        string="Monitor reference",
        index=True,
        copy=False,
        help="Ticket id in CodePR-Monitor. Used to avoid duplicate imports.",
    )

    _sql_constraints = [
        (
            "monitor_ref_unique",
            "unique(monitor_ref)",
            "A ticket with this CodePR-Monitor reference already exists.",
        ),
    ]
