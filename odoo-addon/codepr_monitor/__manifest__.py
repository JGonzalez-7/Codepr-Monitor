{
    "name": "CodePR Monitor Tickets",
    "summary": "Receives web page tickets submitted through CodePR-Monitor.",
    "description": """
CodePR Monitor Tickets
======================

Companion module for the CodePR-Monitor application. CodePR-Monitor owns the
monitoring and the client-facing UI; this module gives Odoo a home for the
tickets clients submit, so support work happens where the rest of the business
already lives.

Records are created over JSON-RPC by the monitor. `monitor_ref` holds the
originating ticket id, which keeps retried pushes from creating duplicates.
""",
    "version": "18.0.1.0.0",
    "category": "Services/Helpdesk",
    "author": "CodePR",
    "website": "https://code.pr",
    "license": "LGPL-3",
    "depends": ["base", "mail"],
    "data": [
        "security/ir.model.access.csv",
        "views/codepr_monitor_ticket_views.xml",
    ],
    "application": True,
    "installable": True,
}
